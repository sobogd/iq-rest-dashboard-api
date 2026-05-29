import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AdminGuard } from "./admin.guard";
import { AuthService } from "../auth/auth.service";
import { MailService } from "../mail/mail.service";
import { DevicesService } from "../devices/devices.service";
import { RestaurantService } from "../restaurant/restaurant.service";
import { authCookieOptions } from "../common/session-utils";
import { validateEmail } from "../common/validate-email";
import type { AuthedRequest } from "../auth/auth.guard";

const SESSION_COOKIE = "iqr_session";
const EMAIL_COOKIE = "iqr_email";
const ADMIN_ORIG_SESSION = "iqr_admin_original_session";
const ADMIN_ORIG_EMAIL = "iqr_admin_original_email";
const ADMIN_ORIG_USER_ID = "iqr_admin_original_user_id";

interface ListQuery {
  tz?: string;
}

@Controller("admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly devices: DevicesService,
    private readonly restaurants: RestaurantService,
  ) {}

  // ────────────────── DEVICES ──────────────────

  // Fan out a force-reload to every paired tablet system-wide.
  // Used after deploying an urgent kitchen-bundle fix — the kiosk SSE
  // handler clears its caches and calls location.reload() on receipt.
  @Post("devices/reload-all")
  reloadAllDevices() {
    return this.devices.reloadAllGlobal();
  }

  // ────────────────── RESTAURANTS (per-restaurant billing UI) ──────────────────

  // Flat list of every restaurant in the system with the aggregates the admin
  // table needs. Primary view for the admin dashboard.
  @Get("restaurants")
  async listRestaurants() {
    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const upper30d = new Date(todayUtc.getTime() + DAY_MS);
    const startOf30d = new Date(upper30d.getTime() - 30 * DAY_MS);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMessagesLastDay = new Date(now.getTime() - DAY_MS);

    const restaurants = await this.prisma.restaurant.findMany({
      select: {
        id: true,
        title: true,
        slug: true,
        plan: true,
        subscriptionStatus: true,
        billingCycle: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        stripeSubscriptionId: true,
        createdAt: true,
        _count: { select: { categories: true, items: true } },
        restaurantUsers: {
          select: { user: { select: { id: true, email: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (restaurants.length === 0) return { restaurants: [] };

    const ids = restaurants.map((r) => r.id);

    const [scans30dRows, scansTodayRows, msgsTotalRows, msgsLastDayRows, lastVisits] = await Promise.all([
      this.prisma.$queryRaw<{ restaurantId: string; count: bigint }[]>`
        SELECT "restaurantId", COUNT(DISTINCT "sessionId") AS count
        FROM page_views WHERE "restaurantId" = ANY(${ids}::text[]) AND "createdAt" >= ${startOf30d}
        GROUP BY "restaurantId"`,
      this.prisma.$queryRaw<{ restaurantId: string; count: bigint }[]>`
        SELECT "restaurantId", COUNT(DISTINCT "sessionId") AS count
        FROM page_views WHERE "restaurantId" = ANY(${ids}::text[]) AND "createdAt" >= ${startOfDay}
        GROUP BY "restaurantId"`,
      this.prisma.$queryRaw<{ restaurantId: string; count: bigint }[]>`
        SELECT "restaurantId", COUNT(*) AS count FROM support_messages
        WHERE "restaurantId" = ANY(${ids}::text[]) AND "isAdmin" = false
        GROUP BY "restaurantId"`,
      this.prisma.$queryRaw<{ restaurantId: string; count: bigint }[]>`
        SELECT "restaurantId", COUNT(*) AS count FROM support_messages
        WHERE "restaurantId" = ANY(${ids}::text[]) AND "isAdmin" = false AND "createdAt" >= ${startOfMessagesLastDay}
        GROUP BY "restaurantId"`,
      this.prisma.$queryRaw<{ restaurantId: string; last_visit: Date | null }[]>`
        SELECT "restaurantId", MAX("createdAt") AS last_visit FROM page_views
        WHERE "restaurantId" = ANY(${ids}::text[])
        GROUP BY "restaurantId"`,
    ]);

    const byId = <T extends { restaurantId: string }>(rows: T[]) => {
      const m = new Map<string, T>();
      for (const r of rows) m.set(r.restaurantId, r);
      return m;
    };
    const s30 = byId(scans30dRows);
    const sToday = byId(scansTodayRows);
    const mTotal = byId(msgsTotalRows);
    const mLastDay = byId(msgsLastDayRows);
    const lv = byId(lastVisits);

    return {
      restaurants: restaurants.map((r) => {
        const plan = r.plan ?? "FREE";
        const subscriptionStatus = r.subscriptionStatus;
        const isManualSub =
          subscriptionStatus === "ACTIVE" && !r.stripeSubscriptionId;
        return {
          id: r.id,
          title: r.title,
          slug: r.slug,
          plan,
          billingCycle: r.billingCycle,
          subscriptionStatus,
          trialEndsAt: r.trialEndsAt ? r.trialEndsAt.toISOString() : null,
          currentPeriodEnd: r.currentPeriodEnd ? r.currentPeriodEnd.toISOString() : null,
          hasStripeSub: !!r.stripeSubscriptionId,
          isManualSub,
          createdAt: r.createdAt.toISOString(),
          users: r.restaurantUsers.map((ru) => ({
            id: ru.user.id,
            email: ru.user.email,
          })),
          usersCount: r.restaurantUsers.length,
          categoriesCount: r._count.categories,
          itemsCount: r._count.items,
          scans30d: Number(s30.get(r.id)?.count ?? 0),
          scansToday: Number(sToday.get(r.id)?.count ?? 0),
          messagesCount: Number(mTotal.get(r.id)?.count ?? 0),
          messagesLastDayCount: Number(mLastDay.get(r.id)?.count ?? 0),
          lastVisit: lv.get(r.id)?.last_visit?.toISOString() ?? null,
        };
      }),
    };
  }

  // Full per-restaurant detail for the admin restaurant modal. Returns the
  // restaurant row + all attached users with their email-campaign history +
  // counts used in the modal header (categories/items/messages).
  @Get("restaurants/:id")
  async restaurantDetail(@Param("id") restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        title: true,
        subtitle: true,
        description: true,
        slug: true,
        address: true,
        phone: true,
        instagram: true,
        whatsapp: true,
        languages: true,
        defaultLanguage: true,
        reservationsEnabled: true,
        plan: true,
        billingCycle: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        stripeSubscriptionId: true,
        paymentProcessing: true,
        createdAt: true,
        _count: { select: { categories: true, items: true, supportMessages: true } },
        restaurantUsers: {
          orderBy: { addedAt: "asc" },
          select: {
            addedAt: true,
            addedBy: true,
            user: {
              select: {
                id: true,
                email: true,
                preferredLocale: true,
                stripeCustomerId: true,
                emailsSent: true,
                emailUnsubscribed: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!restaurant) throw new NotFoundException("Restaurant not found");
    return {
      id: restaurant.id,
      title: restaurant.title,
      subtitle: restaurant.subtitle,
      description: restaurant.description,
      slug: restaurant.slug,
      address: restaurant.address,
      phone: restaurant.phone,
      instagram: restaurant.instagram,
      whatsapp: restaurant.whatsapp,
      languages: restaurant.languages,
      defaultLanguage: restaurant.defaultLanguage,
      reservationsEnabled: restaurant.reservationsEnabled,
      plan: restaurant.plan ?? "FREE",
      billingCycle: restaurant.billingCycle,
      subscriptionStatus: restaurant.subscriptionStatus,
      trialEndsAt: restaurant.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: restaurant.currentPeriodEnd?.toISOString() ?? null,
      hasStripeSub: !!restaurant.stripeSubscriptionId,
      paymentProcessing: restaurant.paymentProcessing,
      createdAt: restaurant.createdAt.toISOString(),
      categoriesCount: restaurant._count.categories,
      itemsCount: restaurant._count.items,
      messagesCount: restaurant._count.supportMessages,
      users: restaurant.restaurantUsers.map((ru) => ({
        id: ru.user.id,
        email: ru.user.email,
        preferredLocale: ru.user.preferredLocale,
        hasStripeCustomer: !!ru.user.stripeCustomerId,
        emailsSent: (ru.user.emailsSent as Record<string, string> | null) ?? null,
        emailUnsubscribed: ru.user.emailUnsubscribed,
        attachedAt: ru.addedAt.toISOString(),
        // null addedBy = original creator (owner); non-null = invited later.
        isOwner: ru.addedBy === null,
        userCreatedAt: ru.user.createdAt.toISOString(),
      })),
    };
  }

  // Cascade-delete a restaurant. Removes RestaurantUsers, devices, orders,
  // menu, support history — everything keyed by restaurantId via Prisma's
  // onDelete: Cascade. RestaurantService.deleteByAdmin also cancels any
  // active Stripe subscription on the restaurant first (best-effort) so the
  // customer isn't billed for a deleted restaurant.
  @Delete("restaurants/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRestaurant(@Param("id") restaurantId: string) {
    await this.restaurants.deleteByAdmin(restaurantId).catch((err) => {
      if (err instanceof NotFoundException) throw err;
      // Prisma "record to delete does not exist" surfaces as P2025.
      const code = (err as { code?: string })?.code;
      if (code === "P2025") throw new NotFoundException("Restaurant not found");
      throw err;
    });
  }

  // Attach an existing user to a restaurant (formerly a "grant"). Type-ahead
  // search returns existing users only; signup for a brand-new email happens
  // through the normal OTP flow first.
  @Post("restaurants/:id/users")
  async attachUserToRestaurant(
    @Req() req: Request,
    @Param("id") restaurantId: string,
    @Body() body: { email?: string },
  ) {
    const email = validateEmail(body.email);
    if (!email) throw new BadRequestException("Valid email required");

    const [restaurant, user] = await Promise.all([
      this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true },
      }),
      this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true } }),
    ]);
    if (!restaurant) throw new NotFoundException("Restaurant not found");
    if (!user) throw new BadRequestException("user_not_registered");

    // addedBy = the admin attaching this user. Non-null marks the attached
    // user as a manager (viaGrant=true), which blocks billing and delete
    // actions in AuthGuard / RestaurantService. Without this, the row defaults
    // to addedBy=NULL, which the model interprets as "owner" — accidentally
    // granting cancel-subscription + delete-restaurant rights to anyone the
    // admin attaches.
    const adminUserId = (req as AuthedRequest).authUser.userId;
    const ru = await this.prisma.restaurantUser.upsert({
      where: { restaurantId_userId: { restaurantId, userId: user.id } },
      create: { restaurantId, userId: user.id, addedBy: adminUserId },
      update: {},
      select: { id: true, addedAt: true },
    });
    return { id: ru.id, userId: user.id, userEmail: user.email, addedAt: ru.addedAt.toISOString() };
  }

  @Delete("restaurants/:id/users/:userId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async detachUserFromRestaurant(
    @Param("id") restaurantId: string,
    @Param("userId") userId: string,
  ) {
    // Block detaching the LAST user — that would orphan the restaurant.
    const count = await this.prisma.restaurantUser.count({ where: { restaurantId } });
    if (count <= 1) {
      throw new BadRequestException("cannot_remove_last_user");
    }
    await this.prisma.restaurantUser
      .delete({ where: { restaurantId_userId: { restaurantId, userId } } })
      .catch(() => {
        throw new NotFoundException("Membership not found");
      });
  }

  // ────────────────── USERS (per-restaurant model admin view) ──────────────────

  // Flat list of every user. Restaurants[] gives the admin a quick read of
  // "what does this person own/manage".
  @Get("users")
  async listUsers() {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        preferredLocale: true,
        createdAt: true,
        stripeCustomerId: true,
        restaurantUsers: {
          select: {
            addedAt: true,
            restaurant: {
              select: {
                id: true,
                title: true,
                slug: true,
                plan: true,
                subscriptionStatus: true,
                stripeSubscriptionId: true,
                trialEndsAt: true,
              },
            },
          },
          orderBy: { addedAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        preferredLocale: u.preferredLocale,
        createdAt: u.createdAt.toISOString(),
        hasStripeCustomer: !!u.stripeCustomerId,
        restaurantsCount: u.restaurantUsers.length,
        hasPaying: u.restaurantUsers.some(
          (ru) =>
            ru.restaurant.subscriptionStatus === "ACTIVE" &&
            ru.restaurant.plan !== null &&
            ru.restaurant.plan !== "FREE",
        ),
        hasActiveTrial: u.restaurantUsers.some(
          (ru) => ru.restaurant.trialEndsAt && ru.restaurant.trialEndsAt > new Date(),
        ),
        restaurants: u.restaurantUsers.map((ru) => ({
          id: ru.restaurant.id,
          title: ru.restaurant.title,
          slug: ru.restaurant.slug,
          plan: ru.restaurant.plan,
          subscriptionStatus: ru.restaurant.subscriptionStatus,
          hasStripeSub: !!ru.restaurant.stripeSubscriptionId,
        })),
      })),
    };
  }

  @Get("users/search")
  async searchUsers(@Query("q") q = "") {
    const term = (q || "").trim().toLowerCase();
    if (!term) return [];
    const users = await this.prisma.user.findMany({
      where: { email: { contains: term, mode: "insensitive" } },
      take: 20,
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true },
    });
    return users;
  }

  // ────────────────── RESTAURANT SUPPORT CHAT ──────────────────

  @Get("restaurants/:id/messages")
  async listMessages(@Param("id") restaurantId: string) {
    return this.prisma.supportMessage.findMany({
      where: { restaurantId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        message: true,
        isAdmin: true,
        createdAt: true,
        user: { select: { email: true } },
      },
    });
  }

  @Post("restaurants/:id/messages")
  async sendMessage(
    @Req() req: Request,
    @Param("id") restaurantId: string,
    @Body() body: { message?: string; locale?: string },
  ) {
    const adminEmail = (req as AuthedRequest).authUser.email;
    const text = (body.message ?? "").trim();
    if (!text) throw new BadRequestException("Message is required");
    if (text.length > 2000) throw new BadRequestException("Message too long");

    const adminUser = await this.prisma.user.findUnique({ where: { email: adminEmail } });
    if (!adminUser) throw new NotFoundException("Admin user not found");

    const created = await this.prisma.supportMessage.create({
      data: { message: text, restaurantId, userId: adminUser.id, isAdmin: true },
      select: {
        id: true,
        message: true,
        isAdmin: true,
        createdAt: true,
        user: { select: { email: true } },
      },
    });

    // Notify any user attached to the restaurant by email (best-effort).
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
    const requestedLocale = (body.locale ?? "").trim().toLowerCase();
    const locale =
      requestedLocale ||
      owner?.preferredLocale ||
      restaurant?.defaultLanguage ||
      "en";
    if (owner?.email) {
      this.mail
        .sendSupportReplyNotification(owner.email, locale)
        .catch((err) => console.error("support email failed:", err));
    }

    return created;
  }

  /** Manually trigger an email template to a specific user.
   *  Records the send in User.emailsSent JSON for tracking + idempotency hint. */
  @Post("users/:id/send-email")
  async sendEmail(
    @Param("id") userId: string,
    @Body() body: { template?: string; locale?: string },
  ) {
    const template = body.template;
    if (template !== "welcome_personal" && template !== "menu_almost_ready" && template !== "trial_ending") {
      throw new BadRequestException("Unknown template");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        restaurantUsers: {
          take: 1,
          orderBy: { addedAt: "asc" },
          select: { restaurant: { select: { title: true, defaultLanguage: true } } },
        },
      },
    });
    if (!user?.email) throw new NotFoundException("User not found");
    if (user.emailUnsubscribed) throw new BadRequestException("User unsubscribed");

    const restaurant = user.restaurantUsers[0]?.restaurant;
    const requestedLocale = (body.locale ?? "").trim().toLowerCase();
    const locale = requestedLocale || user.preferredLocale || restaurant?.defaultLanguage || "en";
    const name = restaurant?.title || user.email.split("@")[0];

    if (template === "welcome_personal") {
      await this.mail.sendWelcomePersonal({ email: user.email, name, locale });
    } else if (template === "trial_ending") {
      await this.mail.sendTrialEnding({ email: user.email, name, locale });
    } else {
      await this.mail.sendMenuAlmostReady({ email: user.email, name, locale });
    }

    const existing =
      user.emailsSent && typeof user.emailsSent === "object" && !Array.isArray(user.emailsSent)
        ? (user.emailsSent as Record<string, string>)
        : {};
    const updated = { ...existing, [template]: new Date().toISOString() };
    await this.prisma.user.update({ where: { id: userId }, data: { emailsSent: updated } });

    return { ok: true, template, sentAt: updated[template], to: user.email, locale };
  }

  // ────────────────── IMPERSONATE ──────────────────

  @Post("impersonate")
  @HttpCode(HttpStatus.OK)
  async impersonate(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { userId?: string },
  ) {
    if (!body.userId) throw new BadRequestException("userId required");

    const adminAuth = (req as AuthedRequest).authUser;
    const target = await this.prisma.user.findUnique({
      where: { id: body.userId },
      select: {
        id: true,
        email: true,
        // Impersonating a user without any attached restaurant locks the admin
        // out — AuthGuard would 401 every subsequent request inside the
        // impersonated session. Require ≥1 attachment so we fail loudly here
        // instead of stranding the admin behind a useless cookie swap.
        _count: { select: { restaurantUsers: true } },
      },
    });
    if (!target) throw new NotFoundException("User not found");
    if (target._count.restaurantUsers === 0) {
      throw new BadRequestException("Target user has no restaurants — cannot impersonate");
    }

    const cookies = req.cookies as Record<string, string | undefined>;
    const adminSession = cookies?.[SESSION_COOKIE];
    if (!adminSession) throw new ForbiddenException("Missing admin session cookie");

    const domain = this.config.get<string>("COOKIE_DOMAIN") || undefined;
    const opts = authCookieOptions(domain);

    // Save admin originals so we can restore on exit. We deliberately keep
    // iqr_session unchanged (still the admin's token); only iqr_email points
    // to the target. resolveSession sees admin_original_* cookies and:
    //   - validates the admin's token against the admin user's sessionToken,
    //   - returns the target user's identity (looked up by iqr_email).
    // The target user's sessionToken is never touched, so they stay logged
    // in everywhere else.
    res.cookie(ADMIN_ORIG_SESSION, adminSession, { ...opts, httpOnly: true });
    res.cookie(ADMIN_ORIG_EMAIL, adminAuth.email, { ...opts, httpOnly: true });
    res.cookie(ADMIN_ORIG_USER_ID, adminAuth.userId, { ...opts, httpOnly: true });
    res.cookie(EMAIL_COOKIE, target.email, { ...opts, httpOnly: false });

    return { ok: true };
  }

  @Post("impersonate/exit")
  @HttpCode(HttpStatus.OK)
  async exitImpersonate(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = req.cookies as Record<string, string | undefined>;
    const origSession = cookies?.[ADMIN_ORIG_SESSION];
    const origEmail = cookies?.[ADMIN_ORIG_EMAIL];
    if (!origSession || !origEmail) {
      throw new BadRequestException("No impersonation session found");
    }

    const domain = this.config.get<string>("COOKIE_DOMAIN") || undefined;
    const opts = authCookieOptions(domain);

    res.cookie(SESSION_COOKIE, origSession, opts);
    res.cookie(EMAIL_COOKIE, origEmail, { ...opts, httpOnly: false });

    res.clearCookie(ADMIN_ORIG_SESSION, { path: "/", ...(domain ? { domain } : {}) });
    res.clearCookie(ADMIN_ORIG_EMAIL, { path: "/", ...(domain ? { domain } : {}) });
    res.clearCookie(ADMIN_ORIG_USER_ID, { path: "/", ...(domain ? { domain } : {}) });

    return { ok: true };
  }

  // ────────────────── USAGE EVENTS (new unified analytics) ──────────────────

  /** Usage events, paginated for infinite scroll across full history.
   *  20 events per page, ordered by at/id desc. */
  @Get("usage/timeline")
  async usageTimeline(
    @Query("scope") scope: "all" | "anonymous" | "identified" = "all",
    @Query("userId") userId?: string,
    @Query("cursor") cursor?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("sort") sort?: "asc" | "desc",
    @Query("similarTo") similarTo?: string,
  ) {
    const where: Prisma.UsageEventWhereInput = {};

    // similarTo: narrow the timeline to rows sharing the geo + device shape
    // of one specific event (same heuristic as /usage/similar). Folds the
    // base event's identifying tuple into `where` so the standard cursor
    // pagination keeps working unchanged.
    if (similarTo) {
      const base = await this.prisma.usageEvent.findUnique({ where: { id: similarTo } });
      if (!base) throw new BadRequestException("similarTo event not found");
      where.country = base.country;
      where.device = base.device;
      where.platform = base.platform;
      if (base.ip) {
        where.ip = base.ip;
      } else {
        where.region = base.region;
        where.ip = null;
      }
    }
    if (userId) {
      where.userId = userId;
    } else if (scope === "anonymous") {
      where.userId = null;
    } else if (scope === "identified") {
      where.userId = { not: null };
    }

    const atRange: { gte?: Date; lt?: Date } = {};
    if (from) {
      const d = new Date(from);
      if (Number.isNaN(d.getTime())) throw new BadRequestException("from invalid");
      atRange.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (Number.isNaN(d.getTime())) throw new BadRequestException("to invalid");
      atRange.lt = d;
    }
    if (atRange.gte || atRange.lt) where.at = atRange;

    const PAGE_SIZE = 50;
    const dir: "asc" | "desc" = sort === "asc" ? "asc" : "desc";
    const rows = await this.prisma.usageEvent.findMany({
      where,
      orderBy: [{ at: dir }, { id: dir }],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        at: true,
        event: true,
        country: true,
        region: true,
        device: true,
        platform: true,
        gclid: true,
        ad_params: true,
        userId: true,
        restaurantId: true,
        ip: true,
        is_search: true,
        is_google_ads: true,
        is_facebook_ads: true,
        fbSentEvents: true,
      },
    });

    const labels = await this.resolveUsageLabels(rows);

    // Total count for the header — only computed on the first page request.
    const total = !cursor ? await this.prisma.usageEvent.count({ where }) : undefined;

    return {
      ...(total !== undefined ? { total } : {}),
      hasMore: rows.length === PAGE_SIZE,
      nextCursor: rows.length === PAGE_SIZE ? rows[rows.length - 1].id : null,
      events: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        event: r.event,
        country: r.country,
        region: r.region,
        device: r.device,
        platform: r.platform,
        gclid: r.gclid,
        adParams: r.ad_params,
        userId: r.userId,
        restaurantId: r.restaurantId,
        label: labels.forRow(r),
        ip: r.ip,
        isSearch: r.is_search,
        isGoogleAds: r.is_google_ads,
        isFacebookAds: r.is_facebook_ads,
        fbSentEvents: r.fbSentEvents,
      })),
    };
  }

  // Resolve userId / restaurantId on a batch of usage events to a single
  // display label (restaurant title preferred, owner email fallback). Pulled
  // out so /usage/timeline and /usage/similar share the same lookup.
  private async resolveUsageLabels(
    rows: { userId: string | null; restaurantId: string | null }[],
  ) {
    const userIds = Array.from(
      new Set(rows.map((r) => r.userId).filter((x): x is string => !!x)),
    );
    const restaurantIds = Array.from(
      new Set(rows.map((r) => r.restaurantId).filter((x): x is string => !!x)),
    );
    const userLabels = new Map<string, string>();
    const restaurantLabels = new Map<string, string>();
    if (userIds.length) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
      });
      for (const u of users) userLabels.set(u.id, u.email);
    }
    if (restaurantIds.length) {
      const restaurants = await this.prisma.restaurant.findMany({
        where: { id: { in: restaurantIds } },
        select: { id: true, title: true },
      });
      for (const r of restaurants) restaurantLabels.set(r.id, r.title);
    }
    return {
      forRow(r: { userId: string | null; restaurantId: string | null }): string | null {
        if (r.restaurantId) return restaurantLabels.get(r.restaurantId) ?? null;
        if (r.userId) return userLabels.get(r.userId) ?? null;
        return null;
      },
    };
  }

  @Get("usage/similar/:id")
  async usageSimilar(@Param("id") id: string) {
    const base = await this.prisma.usageEvent.findUnique({ where: { id } });
    if (!base) throw new NotFoundException("Event not found");

    const where: Prisma.UsageEventWhereInput = {
      country: base.country,
      device: base.device,
      platform: base.platform,
    };
    if (base.ip) {
      where.ip = base.ip;
    } else {
      where.region = base.region;
      where.ip = null;
    }

    const rows = await this.prisma.usageEvent.findMany({
      where,
      orderBy: { at: "desc" },
      take: 500,
      select: {
        id: true, at: true, event: true,
        country: true, region: true, device: true, platform: true,
        gclid: true, ad_params: true, userId: true, restaurantId: true, ip: true,
        is_search: true, is_google_ads: true, is_facebook_ads: true,
        fbSentEvents: true,
      },
    });

    const labels = await this.resolveUsageLabels(rows);

    return {
      total: rows.length,
      events: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        event: r.event,
        country: r.country,
        region: r.region,
        device: r.device,
        platform: r.platform,
        gclid: r.gclid,
        adParams: r.ad_params,
        userId: r.userId,
        restaurantId: r.restaurantId,
        label: labels.forRow(r),
        ip: r.ip,
        isSearch: r.is_search,
        isGoogleAds: r.is_google_ads,
        isFacebookAds: r.is_facebook_ads,
        fbSentEvents: r.fbSentEvents,
      })),
    };
  }

  // ────────────────── BULK EVENT ACTIONS ──────────────────

  @Post("usage/events/delete")
  @HttpCode(HttpStatus.OK)
  async bulkDeleteEvents(@Body() body: { ids?: string[] }) {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((s) => typeof s === "string" && s.length > 0) : [];
    if (ids.length === 0) throw new BadRequestException("ids required");
    const r = await this.prisma.usageEvent.deleteMany({ where: { id: { in: ids } } });
    return { ok: true, deleted: r.count };
  }

}
