import { BadRequestException, Body, Controller, Get, Post, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { RestaurantService } from "./restaurant.service";
import { PrismaService } from "../prisma/prisma.service";
import { callGeminiImage, uploadGeneratedImage } from "../common/gemini-image";
import { consumeAiImageQuota, getAiImageUsage, incrementAiImageUsage } from "../common/ai-quota";
import { getRequestCurrency } from "../common/geo";

@Controller("restaurant")
@UseGuards(AuthGuard)
export class RestaurantController {
  constructor(private readonly svc: RestaurantService, private readonly prisma: PrismaService) {}

  @Get()
  async get(@Req() req: Request) {
    const { companyId } = (req as AuthedRequest).authUser;
    return this.svc.getByCompany(companyId);
  }

  @Post()
  async upsert(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const { companyId } = (req as AuthedRequest).authUser;
    const existing = await this.prisma.restaurant.findFirst({ where: { companyId } });
    if (!existing && !body.currency) {
      body = { ...body, currency: await getRequestCurrency(req) };
    }
    return this.svc.upsert(companyId, body);
  }

  @Put("languages")
  async setLanguages(
    @Req() req: Request,
    @Body() body: { languages: string[]; defaultLanguage: string },
  ) {
    const { companyId } = (req as AuthedRequest).authUser;
    return this.svc.upsert(companyId, {
      languages: body.languages,
      defaultLanguage: body.defaultLanguage,
    });
  }

  @Post("generate-background")
  async generateBackground(@Req() req: Request, @Body() body: { prompt?: string }) {
    const { companyId } = (req as AuthedRequest).authUser;
    const { restaurantId } = await consumeAiImageQuota(this.prisma, companyId);
    const userPrompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    let prompt: string;
    if (userPrompt) {
      prompt = [
        userPrompt,
        "Vertical portrait composition (9:16), suitable as a mobile background.",
        "Dark moody atmosphere — the surface should be dark so white text is readable on top.",
        "Soft, warm, slightly dim lighting. Rich but muted tones.",
        "No people, no hands, no text, no words, no letters, no numbers, no logos, no watermarks, no labels, no signs.",
        "Professional photography.",
      ].join("\n");
    } else {
      const items = await this.prisma.item.findMany({
        where: { companyId, isActive: true },
        select: { name: true },
        take: 6,
      });
      if (items.length === 0) {
        throw new BadRequestException("No menu items to generate background from");
      }
      const sampleItems = items.map((i) => i.name).join(", ");
      prompt = [
        "Top-down flat lay photograph on an elegant dark dining table.",
        `ONLY these items are on the table, nothing else: ${sampleItems}.`,
        "Style: restaurant cuisine. Each item in its own plate/glass/bowl, beautifully arranged.",
        "Bird's eye view, looking straight down at the table.",
        "Spread across the table with space between them. Elegant plating.",
        "Soft, warm, slightly dim lighting. Rich but muted tones.",
        "Dark moody atmosphere — the table surface should be dark so white text is readable on top.",
        "Do NOT add any items that are not in the list above. No extra food, no desserts, no drinks unless listed.",
        "No people, no hands, no text, no words, no letters, no numbers, no logos, no watermarks, no labels, no signs.",
        "Professional food photography. Vertical portrait (9:16).",
      ].join("\n");
    }

    const b64 = await callGeminiImage({ prompt, aspectRatio: "9:16", timeoutMs: 50_000 });
    const url = await uploadGeneratedImage(b64, {
      pathPrefix: "restaurants",
      companyId,
      filenamePrefix: "bg",
      resize: { w: 1080, h: 1920, fit: "cover" },
      quality: 85,
    });
    await incrementAiImageUsage(this.prisma, restaurantId);
    return { url };
  }

  @Get("subscription")
  async subscription(@Req() req: Request) {
    const { companyId } = (req as AuthedRequest).authUser;
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return null;
    const usage = await getAiImageUsage(this.prisma, companyId);
    return {
      plan: company.plan,
      billingCycle: company.billingCycle,
      subscriptionStatus: company.subscriptionStatus,
      currentPeriodEnd: company.currentPeriodEnd?.toISOString() ?? null,
      paymentProcessing: company.paymentProcessing,
      trialEndsAt: company.trialEndsAt?.toISOString() ?? null,
      aiImagesUsed: usage.aiImagesUsed,
      aiImagesLimit: usage.aiImagesLimit,
    };
  }
}
