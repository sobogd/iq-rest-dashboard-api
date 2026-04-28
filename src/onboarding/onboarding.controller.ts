import { Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

@Controller("onboarding")
@UseGuards(AuthGuard)
export class OnboardingController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("complete")
  @HttpCode(HttpStatus.OK)
  async complete(@Req() req: Request) {
    const { companyId } = (req as AuthedRequest).authUser;
    await this.prisma.company.update({
      where: { id: companyId },
      data: { onboardingStep: 3 },
    });
    return { ok: true };
  }
}
