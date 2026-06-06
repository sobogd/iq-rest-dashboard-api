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
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AdminGuard } from "../admin/admin.guard";
import type { AuthedRequest } from "../auth/auth.guard";
import { MailService } from "../mail/mail.service";
import { WhatsappService } from "./whatsapp.service";
import { translateText } from "../common/gemini-translate";

/** Unified admin inbox: WhatsApp contacts + internal support threads, both
 *  opened and answered here. WhatsApp threads carry the auto-translation flow;
 *  internal threads write to support_messages and email the restaurant owner.
 *  Opening a thread marks it read (per-thread `inbox_reads` marker); the
 *  half-hourly digest cron (InboxNotifyService) emails when anything is unread. */
@Controller("admin/inbox")
@UseGuards(AdminGuard)
export class InboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappService,
    private readonly mail: MailService,
  ) {}

  @Get("config")
  config() {
    return { whatsapp: this.wa.isConfigured() };
  }

  /** Unified thread list, newest activity first. filter: all | watched | new | muted. */
  @Get("threads")
  async threads(@Query("filter") filter?: string) {
    const f =
      filter === "watched" || filter === "new" || filter === "muted" ? filter : "all";

    // Read markers + last inbound timestamps drive the unread flag.
    const reads = await this.prisma.inboxRead.findMany();
    const readMap = new Map(reads.map((r) => [r.threadId, r.readAt]));

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
    // Last inbound time per WhatsApp contact (for unread detection).
    const waLastIn = await this.prisma.inboxMessage.groupBy({
      by: ["contactId"],
      where: { direction: "in" },
      _max: { createdAt: true },
    });
    const waLastInMap = new Map(waLastIn.map((g) => [g.contactId, g._max.createdAt]));
    const waThreads = contacts.map((c) => {
      const last = c.messages[0];
      const lastIn = waLastInMap.get(c.id);
      const readAt = readMap.get(`wa:${c.id}`);
      return {
        id: `wa:${c.id}`,
        channel: "whatsapp" as const,
        contactId: c.id,
        // Display priority: admin's custom name → WhatsApp profile name → phone.
        name: c.customName || c.name || c.externalId,
        customName: c.customName,
        externalId: c.externalId,
        lang: c.lang,
        watched: c.watched,
        muted: c.muted,
        unread: !!lastIn && (!readAt || lastIn > readAt),
        lastAt: c.lastMessageAt.toISOString(),
        lastPreview: last ? (last.direction === "in" ? last.translatedRu || last.body : last.translatedRu || last.body) : "",
        lastFromMe: last ? last.direction === "out" : false,
      };
    });

    // Internal support threads (only on the unfiltered/all view to keep it simple).
    let internalThreads: Array<Record<string, unknown>> = [];
    if (f === "all") {
      type Row = {
        rid: string;
        title: string;
        lang: string | null;
        last_at: Date;
        last_in: Date | null;
        last_msg: string;
        last_admin: boolean;
      };
      const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
        SELECT sm."restaurantId" AS rid, r.title, r."defaultLanguage" AS lang,
               max(sm."createdAt") AS last_at,
               max(sm."createdAt") FILTER (WHERE sm."isAdmin" = false) AS last_in,
               (array_agg(sm.message ORDER BY sm."createdAt" DESC))[1] AS last_msg,
               (array_agg(sm."isAdmin" ORDER BY sm."createdAt" DESC))[1] AS last_admin
        FROM support_messages sm
        JOIN restaurants r ON r.id = sm."restaurantId"
        GROUP BY sm."restaurantId", r.title, r."defaultLanguage"
        ORDER BY max(sm."createdAt") DESC
        LIMIT 200
      `);
      internalThreads = rows.map((r) => {
        const readAt = readMap.get(`int:${r.rid}`);
        return {
          id: `int:${r.rid}`,
          channel: "internal" as const,
          restaurantId: r.rid,
          name: r.title,
          lang: r.lang,
          watched: false,
          muted: false,
          unread: !!r.last_in && (!readAt || r.last_in > readAt),
          lastAt: r.last_at.toISOString(),
          lastPreview: r.last_msg,
          lastFromMe: r.last_admin,
        };
      });
    }

    const all = [...waThreads, ...internalThreads].sort((a, b) =>
      (b.lastAt as string).localeCompare(a.lastAt as string),
    );
    return { threads: all };
  }

  /** Messages of one thread (WhatsApp or internal). Opening marks it read. */
  @Get("threads/:id/messages")
  async messages(@Param("id") id: string) {
    const thread = this.parseThread(id);
    if (thread.channel === "internal") {
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: thread.key },
        select: {
          title: true,
          defaultLanguage: true,
          restaurantUsers: {
            take: 1,
            orderBy: { addedAt: "asc" },
            select: { user: { select: { email: true } } },
          },
        },
      });
      if (!restaurant) throw new NotFoundException("Thread not found");
      const msgs = await this.prisma.supportMessage.findMany({
        where: { restaurantId: thread.key },
        orderBy: { createdAt: "asc" },
        take: 500,
        select: { id: true, message: true, isAdmin: true, createdAt: true },
      });
      await this.markRead(id);
      return {
        contact: {
          id: thread.key,
          channel: "internal" as const,
          name: restaurant.restaurantUsers[0]?.user.email || restaurant.title || "Conversation",
          customName: null,
          profileName: null,
          note: null,
          externalId: restaurant.title || "",
          lang: restaurant.defaultLanguage,
          watched: false,
          muted: false,
        },
        messages: msgs.map((m) => ({
          id: m.id,
          direction: m.isAdmin ? ("out" as const) : ("in" as const),
          body: m.message,
          lang: null,
          translatedRu: null,
          status: "",
          createdAt: m.createdAt.toISOString(),
        })),
      };
    }

    const contactId = thread.key;
    const contact = await this.prisma.inboxContact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundException("Thread not found");
    const msgs = await this.prisma.inboxMessage.findMany({
      where: { contactId },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    await this.markRead(id);
    return {
      contact: {
        id: contact.id,
        channel: "whatsapp" as const,
        name: contact.customName || contact.name || contact.externalId,
        customName: contact.customName,
        profileName: contact.name,
        note: contact.note,
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
   *  WITHOUT sending — lets the admin verify before delivery. WhatsApp only. */
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

  /** Send a reply. WhatsApp: translate the Russian reply to the contact's
   *  language and deliver via WhatsApp (stores both). Internal: write a
   *  support_message as admin and email the owner. Either way marks read. */
  @Post("threads/:id/send")
  @HttpCode(HttpStatus.OK)
  async send(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { ru?: string; text?: string },
  ) {
    const thread = this.parseThread(id);
    if (thread.channel === "internal") {
      return this.sendInternal(req, thread.key, body);
    }

    const contactId = thread.key;
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
    await this.markRead(id);
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

  /** Internal support reply: persist as admin message + notify the owner. */
  private async sendInternal(
    req: Request,
    restaurantId: string,
    body: { ru?: string; text?: string },
  ) {
    const text = (body?.text ?? body?.ru ?? "").trim();
    if (!text) throw new BadRequestException("Message is required");
    if (text.length > 2000) throw new BadRequestException("Message too long");

    const adminEmail = (req as AuthedRequest).authUser.email;
    const adminUser = await this.prisma.user.findUnique({ where: { email: adminEmail } });
    if (!adminUser) throw new NotFoundException("Admin user not found");

    const created = await this.prisma.supportMessage.create({
      data: { message: text, restaurantId, userId: adminUser.id, isAdmin: true },
      select: { id: true, message: true, isAdmin: true, createdAt: true },
    });

    // Notify the restaurant owner by email (best-effort).
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        defaultLanguage: true,
        restaurantUsers: {
          take: 1,
          orderBy: { addedAt: "asc" },
          select: { user: { select: { email: true, preferredLocale: true } } },
        },
      },
    });
    const owner = restaurant?.restaurantUsers[0]?.user;
    const locale = owner?.preferredLocale || restaurant?.defaultLanguage || "en";
    if (owner?.email) {
      this.mail
        .sendSupportReplyNotification(owner.email, locale)
        .catch((err) => console.error("support email failed:", err));
    }

    await this.markRead(`int:${restaurantId}`);
    return {
      id: created.id,
      direction: "out" as const,
      body: created.message,
      lang: null,
      translatedRu: null,
      status: "",
      createdAt: created.createdAt.toISOString(),
    };
  }

  /** Pin (watch) / hide (mute) a contact, or edit name/note. WhatsApp only. */
  @Post("contacts/:id/flags")
  @HttpCode(HttpStatus.OK)
  async flags(
    @Param("id") id: string,
    @Body() body: { watched?: boolean; muted?: boolean; customName?: string | null; note?: string | null },
  ) {
    const data: { watched?: boolean; muted?: boolean; customName?: string | null; note?: string | null } = {};
    if (typeof body.watched === "boolean") data.watched = body.watched;
    if (typeof body.muted === "boolean") data.muted = body.muted;
    if (body.customName !== undefined) {
      const v = (body.customName ?? "").trim();
      data.customName = v || null;
    }
    if (body.note !== undefined) {
      const v = (body.note ?? "").trim();
      data.note = v || null;
    }
    if (Object.keys(data).length === 0) throw new BadRequestException("nothing to update");
    await this.prisma.inboxContact.update({ where: { id }, data });
    return { ok: true };
  }

  /** Delete a WhatsApp thread (contact + its messages + read marker). */
  @Delete("threads/:id")
  @HttpCode(HttpStatus.OK)
  async remove(@Param("id") id: string) {
    const contactId = this.waId(id);
    await this.prisma.inboxContact.delete({ where: { id: contactId } });
    await this.prisma.inboxRead.deleteMany({ where: { threadId: id } });
    return { ok: true };
  }

  /** Upsert the read marker for a thread to now(). */
  private async markRead(threadId: string): Promise<void> {
    const now = new Date();
    await this.prisma.inboxRead.upsert({
      where: { threadId },
      update: { readAt: now },
      create: { threadId, readAt: now },
    });
  }

  private parseThread(id: string): { channel: "whatsapp" | "internal"; key: string } {
    if (id.startsWith("wa:")) return { channel: "whatsapp", key: id.slice(3) };
    if (id.startsWith("int:")) return { channel: "internal", key: id.slice(4) };
    throw new BadRequestException("Unknown thread id");
  }

  private waId(id: string): string {
    if (!id.startsWith("wa:")) throw new BadRequestException("WhatsApp thread id required");
    return id.slice(3);
  }
}
