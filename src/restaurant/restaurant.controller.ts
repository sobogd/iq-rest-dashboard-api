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
import { consumeAiImageQuota, getAiImageUsage, refundAiImageUsage, isPaidActive } from "../common/ai-quota";
import { getRequestCurrency } from "../common/geo";

const ACTIVE_RESTAURANT_COOKIE = "iqr_active_restaurant_id";
// 1 year — purely a UI convenience for the browser; AuthGuard validates the
// value against the user's company on every request, so a stale cookie is
// harmless (falls back to primary).
const ACTIVE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

@Controller()
@UseGuards(AuthGuard)
export class RestaurantController {
  constructor(private readonly svc: RestaurantService, private readonly prisma: PrismaService) {}

  // ---- Active restaurant (legacy single-restaurant endpoints) ----

  @Get("restaurant")
  async get(@Req() req: Request) {
    const { restaurantId, companyId } = (req as AuthedRequest).authUser;
    // During onboarding the restaurant may not exist yet — AuthGuard creates
    // a synthetic context only if at least one restaurant exists. So either
    // we have an id (load it) or there's literally nothing in the DB (return
    // null so the old "create on first save" path still works).
    const r = restaurantId ? await this.svc.getActive(restaurantId) : null;
    if (r) return r;
    // Fallback: company has no restaurants yet (orphan / pre-onboarding).
    return this.prisma.restaurant.findFirst({ where: { companyId } });
  }

  @Post("restaurant")
  async upsert(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const { userId, companyId, restaurantId } = (req as AuthedRequest).authUser;
    const existing = restaurantId
      ? await this.prisma.restaurant.findUnique({ where: { id: restaurantId } })
      : await this.prisma.restaurant.findFirst({ where: { companyId } });
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
    return this.svc.upsert(companyId, userId, existing?.id ?? null, body);
  }

  @Put("restaurant/languages")
  async setLanguages(
    @Req() req: Request,
    @Body() body: { languages: string[]; defaultLanguage: string },
  ) {
    const { userId, companyId, restaurantId } = (req as AuthedRequest).authUser;
    return this.svc.upsert(companyId, userId, restaurantId, {
      languages: body.languages,
      defaultLanguage: body.defaultLanguage,
    });
  }

  @Post("restaurant/generate-background")
  async generateBackground(@Req() req: Request, @Body() body: { prompt?: string }) {
    const { companyId, restaurantId } = (req as AuthedRequest).authUser;
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
        companyId,
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
    // Per-restaurant billing: read the subscription state from the ACTIVE
    // restaurant. Falls back to the parent Company's fields when the
    // restaurant row has nothing yet (newly-created restaurants pre-deploy
    // backfill, or schema-mismatch corner cases).
    const { companyId, restaurantId, viaGrant } = (req as AuthedRequest).authUser;
    const [restaurant, company] = await Promise.all([
      this.prisma.restaurant.findUnique({
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
      }),
      this.prisma.company.findUnique({ where: { id: companyId } }),
    ]);
    if (!restaurant && !company) return null;
    const usage = await getAiImageUsage(this.prisma, restaurantId);
    const plan = restaurant?.plan ?? company?.plan ?? null;
    const billingCycle = restaurant?.billingCycle ?? company?.billingCycle ?? null;
    const subscriptionStatus = restaurant?.subscriptionStatus ?? company?.subscriptionStatus ?? "INACTIVE";
    const currentPeriodEnd = restaurant?.currentPeriodEnd ?? company?.currentPeriodEnd ?? null;
    const paymentProcessing = restaurant?.paymentProcessing ?? company?.paymentProcessing ?? false;
    const trialEndsAt = restaurant?.trialEndsAt ?? company?.trialEndsAt ?? null;
    return {
      plan,
      billingCycle,
      subscriptionStatus,
      currentPeriodEnd: currentPeriodEnd ? currentPeriodEnd.toISOString() : null,
      paymentProcessing,
      trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
      aiImagesUsed: usage.aiImagesUsed,
      aiImagesLimit: usage.aiImagesLimit,
      // Plan/usage drive feature gating for the active restaurant; a
      // contractor managing it via grant must not see/manage billing.
      canManageBilling: !viaGrant,
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
    const { userId, ownCompanyId, restaurantId, viaGrant } = (req as AuthedRequest).authUser;
    // Plan gating keys off the user's OWN company (can they add restaurants),
    // not the active restaurant's company which may be an owner they manage.
    const company = await this.prisma.company.findUnique({
      where: { id: ownCompanyId },
      select: { plan: true, subscriptionStatus: true },
    });
    const list = await this.svc.listForUser(userId, ownCompanyId);
    return {
      activeId: restaurantId,
      isPaid: company ? isPaidActive(company) : false,
      // Billing UI is shown only when the active restaurant is the user's own;
      // a granted (managed-for-owner) restaurant hides billing.
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
    // New restaurants always land under the user's OWN company, never the
    // company of a restaurant they merely manage via grant. The creating
    // userId is recorded on the new RestaurantUser row.
    const { userId, ownCompanyId } = (req as AuthedRequest).authUser;
    const created = await this.svc.createForCompany(ownCompanyId, userId, body);
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
    const { userId, ownCompanyId } = (req as AuthedRequest).authUser;
    if (!body?.id) throw new BadRequestException("id required");
    // Allowed targets: any restaurant the user is attached to (the new
    // flat-access model) OR — for legacy rollback safety — a restaurant in
    // the user's own company or in their RestaurantAccess grants.
    const attached = await this.prisma.restaurantUser.findUnique({
      where: { restaurantId_userId: { restaurantId: body.id, userId } },
      select: { restaurantId: true },
    });
    let restaurant: { id: string } | null = attached ? { id: attached.restaurantId } : null;
    if (!restaurant) {
      const owned = await this.prisma.restaurant.findFirst({
        where: { id: body.id, companyId: ownCompanyId },
        select: { id: true },
      });
      restaurant =
        owned ??
        (await this.prisma.restaurantAccess
          .findUnique({
            where: { userId_restaurantId: { userId, restaurantId: body.id } },
            select: { restaurantId: true },
          })
          .then((g) => (g ? { id: g.restaurantId } : null)));
    }
    if (!restaurant) throw new ForbiddenException("Not your restaurant");
    res.cookie(ACTIVE_RESTAURANT_COOKIE, restaurant.id, {
      httpOnly: false,
      sameSite: "lax",
      maxAge: ACTIVE_COOKIE_MAX_AGE_MS,
      path: "/",
    });
    return { activeId: restaurant.id };
  }

  @Delete("restaurants/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    // Scope by the user's OWN company: deleteForCompany only finds a restaurant
    // whose companyId matches, so a granted restaurant (owned by another
    // company) is invisible here → contractors can't delete what they manage.
    const { ownCompanyId } = (req as AuthedRequest).authUser;
    await this.svc.deleteForCompany(ownCompanyId, id);
  }
}
