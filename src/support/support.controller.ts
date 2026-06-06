import { BadRequestException, Body, Controller, Get, Logger, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { detectAndTranslateToRu } from "../common/gemini-translate";

@Controller("support/messages")
@UseGuards(AuthGuard)
export class SupportController {
  private readonly logger = new Logger(SupportController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: Request) {
    // Per-restaurant chat: every user attached to the active restaurant
    // sees the same thread.
    const { restaurantId } = (req as AuthedRequest).authUser;
    return this.prisma.supportMessage.findMany({
      where: { restaurantId },
      orderBy: { createdAt: "asc" },
      select: { id: true, message: true, isAdmin: true, createdAt: true },
    });
  }

  @Post()
  async create(@Req() req: Request, @Body() body: { message?: string }) {
    const { restaurantId, userId } = (req as AuthedRequest).authUser;
    const text = (body.message ?? "").trim();
    if (!text) throw new BadRequestException("Message is required");
    if (text.length > 2000) throw new BadRequestException("Message too long");

    // Auto-translate to Russian for the admin inbox (best-effort).
    let lang: string | null = null;
    let translatedRu: string | null = null;
    try {
      const t = await detectAndTranslateToRu(text);
      lang = t.lang;
      translatedRu = t.ru;
    } catch (err) {
      this.logger.warn(`support translate-to-ru failed: ${(err as Error)?.message ?? err}`);
    }

    const created = await this.prisma.supportMessage.create({
      data: { message: text, restaurantId, userId, isAdmin: false, lang, translatedRu },
      select: { id: true, message: true, isAdmin: true, createdAt: true },
    });

    // Admin is notified by the half-hourly unread-inbox digest cron
    // (InboxNotifyService), not per-message.
    return created;
  }
}
