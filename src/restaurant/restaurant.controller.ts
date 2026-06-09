import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { RestaurantService } from "./restaurant.service";
import { PrismaService } from "../prisma/prisma.service";
import { callGeminiImage, uploadGeneratedImage } from "../common/gemini-image";
import { consumeAiImageQuota, getAiImageUsage, refundAiImageUsage } from "../common/ai-quota";
import { getRequestCurrency } from "../common/geo";

const ACTIVE_RESTAURANT_COOKIE = "iqr_active_restaurant_id";
// 1 year — purely a UI convenience for the browser; AuthGuard validates the
// value against the user's RestaurantUser attachments on every request, so a
// stale cookie is harmless (falls back to primary).
const ACTIVE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

@Controller()
@UseGuards(AuthGuard)
export class RestaurantController {
  constructor(private readonly svc: RestaurantService, private readonly prisma: PrismaService) {}

  // ---- Active restaurant ----

  @Get("restaurant")
  async get(@Req() req: Request) {
    const { restaurantId } = (req as AuthedRequest).authUser;
    return this.svc.getActive(restaurantId);
  }

  @Post("restaurant")
  async upsert(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const { userId, restaurantId } = (req as AuthedRequest).authUser;
    const existing = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!existing && !body.currency) {
      body = { ...body, currency: await getRequestCurrency(req) };
    }
    if (!existing && !body.timezone) {
      const tz = String(req.headers["cf-timezone"] ?? "").trim();
      if (tz) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          body = { ...body, timezone: tz };
        } catch {
          // invalid header value, fall through to schema default
        }
      }
    }
    return this.svc.upsert(userId, existing?.id ?? null, body);
  }

  @Put("restaurant/languages")
  async setLanguages(
    @Req() req: Request,
    @Body() body: { languages: string[]; defaultLanguage: string },
  ) {
    const { userId, restaurantId } = (req as AuthedRequest).authUser;
    return this.svc.upsert(userId, restaurantId, {
      languages: body.languages,
      defaultLanguage: body.defaultLanguage,
    });
  }

  @Post("restaurant/generate-background")
  async generateBackground(@Req() req: Request, @Body() body: { prompt?: string }) {
    const { restaurantId } = (req as AuthedRequest).authUser;
    const { isPaid } = await consumeAiImageQuota(this.prisma, restaurantId);
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
        where: { restaurantId, isActive: true, deletedAt: null },
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

    try {
      const b64 = await callGeminiImage({ prompt, aspectRatio: "9:16", timeoutMs: 50_000 });
      const url = await uploadGeneratedImage(b64, {
        pathPrefix: "restaurants",
        restaurantId,
        filenamePrefix: "bg",
        resize: { w: 1080, h: 1920, fit: "cover" },
        quality: 85,
      });
      return { url };
    } catch (err) {
      if (!isPaid) await refundAiImageUsage(this.prisma, restaurantId);
      throw err;
    }
  }

  @Post("restaurant/dismiss-scan-banner")
  async dismissScanBanner(@Req() req: Request) {
    const { restaurantId } = (req as AuthedRequest).authUser;
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { scanBannerDismissed: true },
    });
    return { ok: true };
  }

  @Get("restaurant/subscription")
  async subscription(@Req() req: Request) {
    // Per-restaurant billing: the subscription state lives on the ACTIVE
    // restaurant. `canManageBilling` is false for users attached as managers
    // (RestaurantUser.addedBy non-null) — they see the page but can't checkout
    // / cancel on the owner's behalf.
    const { restaurantId, viaGrant, isDemo } = (req as AuthedRequest).authUser;
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        plan: true,
        billingCycle: true,
        subscriptionStatus: true,
        currentPeriodEnd: true,
        paymentProcessing: true,
        trialEndsAt: true,
        stripeSubscriptionId: true,
      },
    });
    if (!restaurant) return null;
    const usage = await getAiImageUsage(this.prisma, restaurantId);
    return {
      plan: restaurant.plan,
      billingCycle: restaurant.billingCycle,
      subscriptionStatus: restaurant.subscriptionStatus,
      currentPeriodEnd: restaurant.currentPeriodEnd ? restaurant.currentPeriodEnd.toISOString() : null,
      paymentProcessing: restaurant.paymentProcessing,
      trialEndsAt: restaurant.trialEndsAt ? restaurant.trialEndsAt.toISOString() : null,
      aiImagesUsed: usage.aiImagesUsed,
      aiImagesLimit: usage.aiImagesLimit,
      // Demo accounts can't pay — hide the billing UI (the SPA gates on this).
      canManageBilling: !viaGrant && !isDemo,
    };
  }

  // ---- Multi-restaurant endpoints ----

  @Get("restaurants/slug-preview")
  async slugPreview(@Query("name") name = "") {
    const trimmed = (name || "").trim();
    if (!trimmed) return { slug: "" };
    return { slug: await this.svc.previewSlug(trimmed) };
  }

  @Get("restaurants")
  async list(@Req() req: Request) {
    const { userId, restaurantId, viaGrant } = (req as AuthedRequest).authUser;
    const list = await this.svc.listForUser(userId);
    return {
      activeId: restaurantId,
      // Pre-Company-drop the dashboard SPA used this flag to gate the
      // "+ Add restaurant" button. Per-restaurant billing makes the flag
      // meaningless — anyone can create as many restaurants as they want.
      // Kept in the response shape (always true) for backwards compat.
      isPaid: true,
      canManageBilling: !viaGrant,
      restaurants: list,
    };
  }

  @Post("restaurants")
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { name: string; duplicateFromId?: string | null },
  ) {
    const { userId, isDemo } = (req as AuthedRequest).authUser;
    // Demo accounts can't create extra restaurants — their data is ephemeral
    // and the multi-restaurant flow is a paid-account feature. The SPA hides
    // the "+ Add restaurant" button for demo users; this is the server-side
    // guard against a hand-crafted request.
    if (isDemo) throw new ForbiddenException("Demo accounts cannot create restaurants");
    const created = await this.svc.createForCompany(userId, body);
    // Auto-switch the cookie so the next request lands on the new restaurant.
    res.cookie(ACTIVE_RESTAURANT_COOKIE, created.id, {
      httpOnly: false,
      sameSite: "lax",
      maxAge: ACTIVE_COOKIE_MAX_AGE_MS,
      path: "/",
    });
    return created;
  }

  @Post("restaurants/active")
  async setActive(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { id: string },
  ) {
    const { userId } = (req as AuthedRequest).authUser;
    if (!body?.id) throw new BadRequestException("id required");
    // Allowed targets: any restaurant the user is attached to via the flat
    // RestaurantUser access model.
    const attached = await this.prisma.restaurantUser.findUnique({
      where: { restaurantId_userId: { restaurantId: body.id, userId } },
      select: { restaurantId: true },
    });
    if (!attached) throw new ForbiddenException("Not your restaurant");
    res.cookie(ACTIVE_RESTAURANT_COOKIE, attached.restaurantId, {
      httpOnly: false,
      sameSite: "lax",
      maxAge: ACTIVE_COOKIE_MAX_AGE_MS,
      path: "/",
    });
    return { activeId: attached.restaurantId };
  }

  @Delete("restaurants/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    // Only the original creator (RestaurantUser.addedBy === null) can delete;
    // attached managers can't. Service throws otherwise.
    const { userId } = (req as AuthedRequest).authUser;
    await this.svc.deleteForUser(userId, id);
  }
}
