import { BadRequestException, Body, Controller, Get, Logger, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { MailService } from "../mail/mail.service";
import { PrismaService } from "../prisma/prisma.service";

@Controller("support/messages")
@UseGuards(AuthGuard)
export class SupportController {
  private readonly logger = new Logger(SupportController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

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

    const created = await this.prisma.supportMessage.create({
      data: { message: text, restaurantId, userId, isAdmin: false },
      select: { id: true, message: true, isAdmin: true, createdAt: true },
    });

    // Fire-and-forget admin notification — SMTP errors must not bubble
    // back to the writer, the message itself was already persisted.
    void this.notifyAdmin({ restaurantId, userId, text }).catch((err) => {
      this.logger.warn(`admin support notification failed: ${err?.message ?? err}`);
    });

    return created;
  }

  private async notifyAdmin({
    restaurantId,
    userId,
    text,
  }: {
    restaurantId: string;
    userId: string;
    text: string;
  }): Promise<void> {
    const [restaurant, user] = await Promise.all([
      this.prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { title: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    await this.mail.sendAdminSupportNewMessageNotification({
      companyName: restaurant?.title ?? "Unnamed restaurant",
      userEmail: user?.email ?? "unknown",
      message: text,
    });
  }
}
