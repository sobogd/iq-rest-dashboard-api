import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AdminGuard } from "../admin/admin.guard";
import { WhatsappService } from "./whatsapp.service";
import { translateText } from "../common/gemini-translate";

/** Unified admin inbox: WhatsApp contacts + internal support threads. WhatsApp
 *  threads carry the auto-translation flow; internal threads are surfaced here
 *  too (the existing support-chat page handles their replies). */
@Controller("admin/inbox")
@UseGuards(AdminGuard)
export class InboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappService,
  ) {}

  @Get("config")
  config() {
    return { whatsapp: this.wa.isConfigured() };
  }

  /** Unified thread list, newest activity first. filter: all | watched | new. */
  @Get("threads")
  async threads(@Query("filter") filter?: string) {
    const f =
      filter === "watched" || filter === "new" || filter === "muted" ? filter : "all";

    // WhatsApp threads.
    const contacts = await this.prisma.inboxContact.findMany({
      where: {
        channel: "whatsapp",
        ...(f === "watched" ? { watched: true, muted: false } : {}),
        // "new" surfaces non-muted contacts not yet curated (watch/mute).
        ...(f === "new" ? { watched: false, muted: false } : {}),
        ...(f === "muted" ? { muted: true } : {}),
        ...(f === "all" ? { muted: false } : {}),
      },
      orderBy: { lastMessageAt: "desc" },
      take: 200,
      include: {
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    const waThreads = contacts.map((c) => {
      const last = c.messages[0];
      return {
        id: `wa:${c.id}`,
        channel: "whatsapp" as const,
        contactId: c.id,
        name: c.name || c.externalId,
        externalId: c.externalId,
        lang: c.lang,
        watched: c.watched,
        muted: c.muted,
        lastAt: c.lastMessageAt.toISOString(),
        lastPreview: last ? (last.direction === "in" ? last.translatedRu || last.body : last.translatedRu || last.body) : "",
        lastFromMe: last ? last.direction === "out" : false,
      };
    });

    // Internal support threads (only on the unfiltered/all view to keep it simple).
    let internalThreads: Array<Record<string, unknown>> = [];
    if (f === "all") {
      type Row = { rid: string; title: string; lang: string | null; last_at: Date; last_msg: string; last_admin: boolean };
      const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT sm."restaurantId" AS rid, r.title, r."defaultLanguage" AS lang,
               max(sm."createdAt") AS last_at,
               (array_agg(sm.message ORDER BY sm."createdAt" DESC))[1] AS last_msg,
               (array_agg(sm."isAdmin" ORDER BY sm."createdAt" DESC))[1] AS last_admin
        FROM support_messages sm
        JOIN restaurants r ON r.id = sm."restaurantId"
        GROUP BY sm."restaurantId", r.title, r."defaultLanguage"
        ORDER BY max(sm."createdAt") DESC
        LIMIT 200
      `);
      internalThreads = rows.map((r) => ({
        id: `int:${r.rid}`,
        channel: "internal" as const,
        restaurantId: r.rid,
        name: r.title,
        lang: r.lang,
        watched: false,
        muted: false,
        lastAt: r.last_at.toISOString(),
        lastPreview: r.last_msg,
        lastFromMe: r.last_admin,
      }));
    }

    const all = [...waThreads, ...internalThreads].sort((a, b) =>
      (b.lastAt as string).localeCompare(a.lastAt as string),
    );
    return { threads: all };
  }

  /** Messages of one WhatsApp thread (internal threads use the support page). */
  @Get("threads/:id/messages")
  async messages(@Param("id") id: string) {
    const contactId = this.waId(id);
    const contact = await this.prisma.inboxContact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundException("Thread not found");
    const msgs = await this.prisma.inboxMessage.findMany({
      where: { contactId },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    return {
      contact: {
        id: contact.id,
        name: contact.name || contact.externalId,
        externalId: contact.externalId,
        lang: contact.lang,
        watched: contact.watched,
        muted: contact.muted,
      },
      messages: msgs.map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        lang: m.lang,
        translatedRu: m.translatedRu,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /** Preview the translation of a Russian reply in the contact's language,
   *  WITHOUT sending — lets the admin verify before delivery. */
  @Post("threads/:id/preview")
  @HttpCode(HttpStatus.OK)
  async preview(@Param("id") id: string, @Body() body: { ru?: string }) {
    const contactId = this.waId(id);
    const ru = (body?.ru ?? "").trim();
    if (!ru) throw new BadRequestException("ru text required");
    const contact = await this.prisma.inboxContact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundException("Thread not found");
    const target = contact.lang || "en";
    let text = ru;
    if (target !== "ru") {
      try {
        text = await translateText(ru, target, "ru");
      } catch {
        text = ru;
      }
    }
    return { lang: target, text };
  }

  /** Send a reply written in Russian; translate to the contact's language and
   *  deliver via WhatsApp. Stores both the sent text and the RU original. If
   *  `text` is supplied (the approved preview), it is sent verbatim so what the
   *  admin saw is exactly what goes out. */
  @Post("threads/:id/send")
  @HttpCode(HttpStatus.OK)
  async send(@Param("id") id: string, @Body() body: { ru?: string; text?: string }) {
    const contactId = this.waId(id);
    const ru = (body?.ru ?? "").trim();
    if (!ru) throw new BadRequestException("ru text required");
    const contact = await this.prisma.inboxContact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundException("Thread not found");

    const target = contact.lang || "en";
    const approved = (body?.text ?? "").trim();
    let outText = approved || ru;
    if (!approved && target !== "ru") {
      try {
        outText = await translateText(ru, target, "ru");
      } catch {
        outText = ru; // fall back to sending the Russian text if translation fails
      }
    }

    const result = await this.wa.sendText(contact.externalId, outText);
    const msg = await this.prisma.inboxMessage.create({
      data: {
        contactId,
        direction: "out",
        body: outText,
        lang: target,
        translatedRu: ru,
        externalId: result.wamid ?? null,
        status: result.ok ? "sent" : "failed",
      },
    });
    await this.prisma.inboxContact.update({
      where: { id: contactId },
      data: { lastMessageAt: new Date() },
    });
    if (!result.ok) throw new BadRequestException({ message: "WhatsApp send failed", response: result.error });
    return {
      id: msg.id,
      direction: "out",
      body: outText,
      lang: target,
      translatedRu: ru,
      status: msg.status,
      createdAt: msg.createdAt.toISOString(),
    };
  }

  /** Pin (watch) / hide (mute) a contact. */
  @Post("contacts/:id/flags")
  @HttpCode(HttpStatus.OK)
  async flags(@Param("id") id: string, @Body() body: { watched?: boolean; muted?: boolean }) {
    const data: { watched?: boolean; muted?: boolean } = {};
    if (typeof body.watched === "boolean") data.watched = body.watched;
    if (typeof body.muted === "boolean") data.muted = body.muted;
    if (Object.keys(data).length === 0) throw new BadRequestException("nothing to update");
    await this.prisma.inboxContact.update({ where: { id }, data });
    return { ok: true };
  }

  /** Delete a WhatsApp thread (contact + its messages). */
  @Delete("threads/:id")
  @HttpCode(HttpStatus.OK)
  async remove(@Param("id") id: string) {
    const contactId = this.waId(id);
    await this.prisma.inboxContact.delete({ where: { id: contactId } });
    return { ok: true };
  }

  private waId(id: string): string {
    if (!id.startsWith("wa:")) throw new BadRequestException("WhatsApp thread id required");
    return id.slice(3);
  }
}
