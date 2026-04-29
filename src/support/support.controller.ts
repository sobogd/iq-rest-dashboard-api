import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

@Controller("support/messages")
@UseGuards(AuthGuard)
export class SupportController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: Request) {
    const { companyId } = (req as AuthedRequest).authUser;
    return this.prisma.supportMessage.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
      select: { id: true, message: true, isAdmin: true, createdAt: true },
    });
  }

  @Post()
  async create(@Req() req: Request, @Body() body: { message?: string }) {
    const { companyId, userId } = (req as AuthedRequest).authUser;
    const text = (body.message ?? "").trim();
    if (!text) throw new BadRequestException("Message is required");
    if (text.length > 2000) throw new BadRequestException("Message too long");
    return this.prisma.supportMessage.create({
      data: { message: text, companyId, userId, isAdmin: false },
      select: { id: true, message: true, isAdmin: true, createdAt: true },
    });
  }
}
