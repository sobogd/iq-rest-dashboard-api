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
    // sees the same thread. Falls back to legacy companyId for messages
    // written before restaurantId was populated.
    const { companyId, restaurantId } = (req as AuthedRequest).authUser;
    return this.prisma.supportMessage.findMany({
      where: {
        OR: [{ restaurantId }, { restaurantId: null, companyId }],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, message: true, isAdmin: true, createdAt: true },
    });
  }

  @Post()
  async create(@Req() req: Request, @Body() body: { message?: string }) {
    const { companyId, restaurantId, userId } = (req as AuthedRequest).authUser;
    const text = (body.message ?? "").trim();
    if (!text) throw new BadRequestException("Message is required");
    if (text.length > 2000) throw new BadRequestException("Message too long");

    const created = await this.prisma.supportMessage.create({
      data: { message: text, companyId, restaurantId, userId, isAdmin: false },
      select: { id: true, message: true, isAdmin: true, createdAt: true },
    });

    // Fire-and-forget admin notification — SMTP errors must not bubble
    // back to the writer, the message itself was already persisted.
    void this.notifyAdmin({ companyId, userId, text }).catch((err) => {
      this.logger.warn(`admin support notification failed: ${err?.message ?? err}`);
    });

    return created;
  }

  private async notifyAdmin({
    companyId,
    userId,
    text,
  }: {
    companyId: string;
    userId: string;
    text: string;
  }): Promise<void> {
    const [company, user] = await Promise.all([
      this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    await this.mail.sendAdminSupportNewMessageNotification({
      companyName: company?.name ?? "Unnamed company",
      userEmail: user?.email ?? "unknown",
      message: text,
    });
  }
}
