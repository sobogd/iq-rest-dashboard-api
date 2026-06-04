import { Controller, Get, Post, Query, Req, Res, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "./whatsapp.service";
import { detectAndTranslateToRu } from "../common/gemini-translate";

/** Public WhatsApp Cloud API webhook. GET = Meta's verification handshake;
 *  POST = inbound message delivery. No AuthGuard (Meta calls it) — POST is
 *  protected by the X-Hub-Signature-256 HMAC over the raw body. */
@Controller("whatsapp")
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappService,
  ) {}

  // Meta verification: echo hub.challenge when the verify token matches.
  @Get("webhook")
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ) {
    if (mode === "subscribe" && token && token === this.wa.verifyToken) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send("forbidden");
  }

  @Post("webhook")
  async receive(@Req() req: Request, @Res() res: Response) {
    // Always 200 fast so Meta doesn't retry; process inline but guard errors.
    if (!this.verifySignature(req)) {
      res.status(401).send("bad signature");
      return;
    }
    res.status(200).send("ok");
    try {
      await this.handlePayload(req.body as WebhookBody);
    } catch (e) {
      this.logger.error(`WhatsApp webhook processing failed: ${String(e)}`);
    }
  }

  private verifySignature(req: Request): boolean {
    const secret = this.wa.appSecret;
    // If no secret configured (e.g. local/demo), don't hard-fail.
    if (!secret) return true;
    const header = req.headers["x-hub-signature-256"];
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (typeof header !== "string" || !raw) return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handlePayload(body: WebhookBody): Promise<void> {
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const profileName = value?.contacts?.[0]?.profile?.name ?? null;
        for (const msg of value?.messages ?? []) {
          if (msg.type !== "text" || !msg.text?.body) continue;
          await this.ingest(msg.from, profileName, msg.id, msg.text.body);
        }
      }
    }
  }

  private async ingest(
    fromPhone: string,
    name: string | null,
    wamid: string,
    text: string,
  ): Promise<void> {
    const contact = await this.prisma.inboxContact.upsert({
      where: { channel_externalId: { channel: "whatsapp", externalId: fromPhone } },
      update: { lastMessageAt: new Date(), ...(name ? { name } : {}) },
      create: { channel: "whatsapp", externalId: fromPhone, name, lastMessageAt: new Date() },
    });

    // Translate to Russian (best-effort); also remember the contact's language.
    let lang: string | null = null;
    let ru: string | null = null;
    try {
      const t = await detectAndTranslateToRu(text);
      lang = t.lang;
      ru = t.ru;
      if (lang && lang !== contact.lang) {
        await this.prisma.inboxContact.update({ where: { id: contact.id }, data: { lang } });
      }
    } catch (e) {
      this.logger.warn(`translate-to-ru failed for ${fromPhone}: ${String(e)}`);
    }

    await this.prisma.inboxMessage.create({
      data: {
        contactId: contact.id,
        direction: "in",
        body: text,
        lang: lang ?? contact.lang,
        translatedRu: ru,
        externalId: wamid,
        status: "received",
      },
    });
  }
}

interface WebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ profile?: { name?: string } }>;
        messages?: Array<{
          from: string;
          id: string;
          type: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}
