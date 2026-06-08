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
import { UsageStitchService } from "./usage-stitch.service";
import { analyzeSession } from "./usage-analyze";
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
    private readonly stitch: UsageStitchService,
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
    const startOfLastVisit = new Date(now.getTime() - 90 * DAY_MS);

    const restaurants = await this.prisma.restaurant.findMany({
      select: {
        id: true,
        title: true,
        slug: true,
        defaultLanguage: true,
        plan: true,
        subscriptionStatus: true,
        billingCycle: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        stripeSubscriptionId: true,
        adminComment: true,
        createdAt: true,
        _count: { select: { categories: true, items: true } },
        restaurantUsers: {
          orderBy: { addedAt: "asc" },
          select: { addedBy: true, user: { select: { id: true, email: true, emailsSent: true } } },
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
        WHERE "restaurantId" = ANY(${ids}::text[])
        GROUP BY "restaurantId"`,
      this.prisma.$queryRaw<{ restaurantId: string; count: bigint }[]>`
        SELECT "restaurantId", COUNT(*) AS count FROM support_messages
        WHERE "restaurantId" = ANY(${ids}::text[]) AND "isAdmin" = false AND "createdAt" >= ${startOfMessagesLastDay}
        GROUP BY "restaurantId"`,
      // "Last visit" = last time anyone attached to this restaurant was
      // active in the dashboard. Joined through restaurant_users → usage_events
      // by userId (not usage_events.restaurantId), because the
      // iqr_active_restaurant_id cookie that pins restaurantId is only set
      // when the owner switches between restaurants — single-restaurant
      // owners never trip it, so their events have restaurantId NULL.
      this.prisma.$queryRaw<{ restaurantId: string; last_visit: Date | null }[]>`
        SELECT ru."restaurantId", MAX(ue."at") AS last_visit
        FROM restaurant_users ru
        JOIN usage_events ue ON ue."userId" = ru."userId"
        WHERE ru."restaurantId" = ANY(${ids}::text[]) AND ue."at" >= ${startOfLastVisit}
        GROUP BY ru."restaurantId"`,
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

    // The 3 lifecycle email templates an admin can trigger; we report how many
    // distinct ones the owner has received (e.g. 1/3) instead of a date.
    const EMAIL_TEMPLATES = ["welcome_personal", "menu_almost_ready", "trial_ending"];

    return {
      restaurants: restaurants.map((r) => {
        const plan = r.plan ?? "FREE";
        const subscriptionStatus = r.subscriptionStatus;
        const isManualSub =
          subscriptionStatus === "ACTIVE" && !r.stripeSubscriptionId;
        // Owner = the user with addedBy === null (falls back to the first).
        const ownerRu = r.restaurantUsers.find((ru) => ru.addedBy === null) ?? r.restaurantUsers[0];
        const sent = (ownerRu?.user.emailsSent as Record<string, unknown> | null) ?? null;
        const emailsSentCount = sent ? EMAIL_TEMPLATES.filter((t) => t in sent).length : 0;
        return {
          id: r.id,
          title: r.title,
          slug: r.slug,
          defaultLanguage: r.defaultLanguage,
          plan,
          billingCycle: r.billingCycle,
          subscriptionStatus,
          trialEndsAt: r.trialEndsAt ? r.trialEndsAt.toISOString() : null,
          currentPeriodEnd: r.currentPeriodEnd ? r.currentPeriodEnd.toISOString() : null,
          hasStripeSub: !!r.stripeSubscriptionId,
          isManualSub,
          hasAdminComment: !!(r.adminComment && r.adminComment.trim().length > 0),
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
          emailsSentCount,
          emailTemplatesTotal: EMAIL_TEMPLATES.length,
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
        adminComment: true,
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
      adminComment: restaurant.adminComment,
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

  // Update the admin-only note attached to a restaurant. Empty string clears
  // it back to null so the modal doesn't keep blank rows around.
  @Post("restaurants/:id/admin-comment")
  @HttpCode(HttpStatus.OK)
  async updateRestaurantAdminComment(
    @Param("id") restaurantId: string,
    @Body() body: { adminComment?: string | null },
  ) {
    const raw = body?.adminComment;
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      throw new BadRequestException("adminComment must be a string or null");
    }
    const next = typeof raw === "string" && raw.trim().length > 0 ? raw : null;
    const updated = await this.prisma.restaurant
      .update({
        where: { id: restaurantId },
        data: { adminComment: next },
        select: { adminComment: true },
      })
      .catch((err) => {
        const code = (err as { code?: string })?.code;
        if (code === "P2025") throw new NotFoundException("Restaurant not found");
        throw err;
      });
    return { ok: true, adminComment: updated.adminComment };
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

    if (template === "welcome_personal") {
      await this.mail.sendWelcomePersonal({ email: user.email, locale });
    } else if (template === "trial_ending") {
      await this.mail.sendTrialEnding({ email: user.email, locale });
    } else {
      await this.mail.sendMenuAlmostReady({ email: user.email, locale });
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

  /** Sessions inside a [from, to) window (default: last 30 days). Groups by the
   *  effective restaurant — the event's restaurantId, else the restaurant
   *  attached to its userId — so a venue's whole activity (across devices/days)
   *  collapses into one row. Anonymous events (no restaurant/user) group by
   *  ip/region. Device/platform are NOT part of the key. */
  @Get("usage/sessions")
  async usageSessions(@Query("from") from?: string, @Query("to") to?: string) {
    let start: Date;
    let end: Date;
    if (from && to) {
      start = new Date(from);
      end = new Date(to);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new BadRequestException("from/to invalid");
      }
    } else {
      end = new Date();
      start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    type Row = {
      kind: string;
      rid: string | null;
      uid: string | null;
      ipkey: string | null;
      has_ip: boolean;
      country: string;
      region: string | null;
      first_at: Date;
      last_at: Date;
      event_count: number;
      has_google: boolean;
      has_fb: boolean;
      has_onb: boolean;
      has_content: boolean;
      has_registered: boolean;
      last_fbclid_event: string | null;
      last_fb_at: Date | null;
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH ev AS (
        SELECT ue.*,
               COALESCE(ue."manualRestaurantId", ue."restaurantId", ue."stitchedRestaurantId", ru."restaurantId") AS eff_rid,
               COALESCE(ue."userId", ue."stitchedUserId") AS eff_uid
        FROM usage_events ue
        LEFT JOIN LATERAL (
          SELECT "restaurantId" FROM restaurant_users
          WHERE "userId" = COALESCE(ue."userId", ue."stitchedUserId") ORDER BY "addedAt" ASC LIMIT 1
        ) ru ON COALESCE(ue."userId", ue."stitchedUserId") IS NOT NULL
        WHERE ue.at >= ${start} AND ue.at < ${end}
      )
      SELECT
        CASE WHEN eff_rid IS NOT NULL THEN 'r' ELSE 'a' END AS kind,
        eff_rid AS rid,
        (array_remove(array_agg(DISTINCT eff_uid), NULL))[1] AS uid,
        MAX(COALESCE(ip, region)) AS ipkey,
        bool_or(ip IS NOT NULL) AS has_ip,
        MAX(country) AS country,
        MAX(region) AS region,
        MIN(at) AS first_at,
        MAX(at) AS last_at,
        COUNT(*)::int AS event_count,
        bool_or(gclid IS NOT NULL OR is_google_ads) AS has_google,
        bool_or(is_facebook_ads OR event LIKE 'l_fbclid_%') AS has_fb,
        bool_or(event LIKE '%onb%') AS has_onb,
        bool_or(event = 'l_page_pricing' OR event LIKE '%demo%') AS has_content,
        bool_or(event = 'l_onb_verify_success' OR event LIKE 'dash\\_%') AS has_registered,
        (array_agg(event ORDER BY at DESC) FILTER (WHERE event LIKE 'l_fbclid_%'))[1] AS last_fbclid_event,
        MAX(at) FILTER (WHERE event LIKE 'l_fbclid_%') AS last_fb_at
      FROM ev
      GROUP BY eff_rid, (CASE WHEN eff_rid IS NULL THEN COALESCE(ip, region) END)
      ORDER BY MAX(at) DESC
    `);

    const labels = await this.resolveUsageLabels(
      rows.map((r) => ({ userId: r.uid, restaurantId: r.rid })),
    );

    // Which sessions belong to ephemeral demo accounts — so the admin sees a
    // "demo" marker and we don't count them as real registrations (mirrors the
    // CAPI cron's demo exclusion).
    const uids = Array.from(new Set(rows.map((r) => r.uid).filter((x): x is string => !!x)));
    const demoSet = new Set<string>();
    if (uids.length) {
      const us = await this.prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, email: true, isDemo: true } });
      for (const u of us) {
        if (u.isDemo || u.email === "demo@iq-rest.com" || u.email.startsWith("demo+")) demoSet.add(u.id);
      }
    }

    // Which sessions already had a Meta CAPI event sent? Flag by the session's
    // latest fbclid (the one the FB chip would send to). One indexed lookup on
    // the small capi_sends journal — no per-session queries.
    const fbclids = Array.from(
      new Set(
        rows
          .map((r) => (r.last_fbclid_event ? r.last_fbclid_event.replace(/^l_fbclid_/, "") : null))
          .filter((x): x is string => !!x),
      ),
    );
    // fbclid → set of successfully-sent CAPI event names.
    const sentByFbclid = new Map<string, Set<string>>();
    if (fbclids.length) {
      const sent = await this.prisma.capiSend.findMany({
        where: { fbclid: { in: fbclids }, status: "success" },
        select: { fbclid: true, eventName: true },
      });
      for (const s of sent) {
        let set = sentByFbclid.get(s.fbclid);
        if (!set) { set = new Set(); sentByFbclid.set(s.fbclid, set); }
        set.add(s.eventName);
      }
    }
    // Deepest funnel milestone sent → chip colour (reg > checkout > view).
    const fbStageOf = (fbclid: string | null): "reg" | "checkout" | "view" | null => {
      if (!fbclid) return null;
      const set = sentByFbclid.get(fbclid);
      if (!set || set.size === 0) return null;
      if (set.has("CompleteRegistration") || set.has("Subscribe")) return "reg";
      if (set.has("InitiateCheckout")) return "checkout";
      if (set.has("ViewContent")) return "view";
      return "view"; // some other event was sent — still mark as touched
    };

    return {
      sessions: rows.map((r) => {
        const latestFbclid = r.last_fbclid_event ? r.last_fbclid_event.replace(/^l_fbclid_/, "") : null;
        const isDemo = r.uid ? demoSet.has(r.uid) : false;
        return {
          kind: r.kind,
          rid: r.rid,
          ipkey: r.ipkey,
          hasIp: r.has_ip,
          country: r.country,
          region: r.region,
          firstAt: r.first_at.toISOString(),
          lastAt: r.last_at.toISOString(),
          eventCount: r.event_count,
          hasGoogle: r.has_google,
          hasFacebook: r.has_fb,
          hasOnboarding: r.has_onb,
          hasContent: r.has_content,
          // Real registration only — a demo account hitting the dashboard is not
          // a registration (it has a fake email).
          hasRegistered: r.has_registered && !isDemo,
          isDemo,
          latestFbclid,
          latestFbTs: r.last_fb_at ? r.last_fb_at.getTime() : null,
          fbStage: fbStageOf(latestFbclid),
          userLabel: r.uid ? labels.email(r.uid) : null,
          restaurantLabel: labels.restaurantName(r.rid, r.uid),
        };
      }),
    };
  }

  /** Events of one session within [from, to]. kind 'r' → all events of the
   *  restaurant (its restaurantId or any attached user's events); kind 'a' →
   *  events of the anonymous ip/region. Newest-first; each carries its own
   *  ip/device/platform. */
  @Get("usage/sessions/events")
  async usageSessionEvents(
    @Query("kind") kind?: string,
    @Query("rid") rid?: string,
    @Query("ipkey") ipkey?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const { rows, summary } = await this.loadSessionEvents(kind, rid, ipkey, from, to);
    return {
      summary,
      events: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        event: r.event,
        ip: r.ip,
        device: r.device,
        platform: r.platform,
        gclid: r.gclid,
        isFacebookAds: r.is_facebook_ads,
      })),
    };
  }

  // AI behavioural analysis of one session — same grouping/window as the events
  // endpoint, then hands the transcript + product/event-vocabulary context to
  // Gemini (see usage-analyze.ts) and returns a Russian narrative.
  @Post("usage/sessions/analyze")
  async analyzeUsageSession(
    @Body()
    body: { kind?: string; rid?: string; ipkey?: string; from?: string; to?: string },
  ) {
    const { rows, summary } = await this.loadSessionEvents(
      body.kind,
      body.rid,
      body.ipkey,
      body.from,
      body.to,
    );
    if (rows.length === 0) {
      return { analysis: "В этой сессии нет событий для анализа." };
    }
    const analysis = await analyzeSession(
      rows.map((r) => ({
        at: r.at.toISOString(),
        event: r.event,
        device: r.device,
        platform: r.platform,
        country: r.country,
        region: r.region,
      })),
      {
        country: summary.country,
        region: summary.region,
        userLabel: summary.userLabel,
        restaurantLabel: summary.restaurantLabel,
        eventCount: summary.eventCount,
        hasGoogle: summary.hasGoogle,
        hasFacebook: summary.hasFacebook,
      },
    );
    return { analysis };
  }

  // Shared loader for one usage session: validates the window, runs the
  // effective-restaurant grouped query, and resolves the header summary. Used
  // by both the events listing and the AI analysis endpoint.
  private async loadSessionEvents(
    kind?: string,
    rid?: string,
    ipkey?: string,
    from?: string,
    to?: string,
  ) {
    if (!from || !to) throw new BadRequestException("from/to required");
    const fromD = new Date(from);
    const toD = new Date(to);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
      throw new BadRequestException("from/to invalid");
    }
    // Match the SAME effective-restaurant grouping as /usage/sessions so an
    // anonymous (ip) group never leaks identified events that merely share its
    // ip, and a restaurant group catches its userId-only events.
    if (kind === "r" && !rid) throw new BadRequestException("rid required");
    const cond =
      kind === "r"
        ? Prisma.sql`eff_rid = ${rid}`
        : Prisma.sql`eff_rid IS NULL AND COALESCE(ip, region) = ${ipkey ?? ""}`;
    type Row = {
      id: string;
      at: Date;
      event: string;
      ip: string | null;
      country: string | null;
      region: string | null;
      device: string | null;
      platform: string | null;
      gclid: string | null;
      is_facebook_ads: boolean;
      is_google_ads: boolean;
      eff_rid: string | null;
      eff_uid: string | null;
      total: number;
    };
    // COUNT(*) OVER() is computed before LIMIT, so each returned row carries the
    // true total even though we cap the listed events at 2000.
    const LIST_LIMIT = 2000;
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH ev AS (
        SELECT ue.id, ue.at, ue.event, ue.ip, ue.country, ue.region, ue.device, ue.platform,
               ue.gclid, ue.is_facebook_ads, ue.is_google_ads,
               COALESCE(ue."userId", ue."stitchedUserId") AS eff_uid,
               COALESCE(ue."manualRestaurantId", ue."restaurantId", ue."stitchedRestaurantId", ru."restaurantId") AS eff_rid
        FROM usage_events ue
        LEFT JOIN LATERAL (
          SELECT "restaurantId" FROM restaurant_users
          WHERE "userId" = COALESCE(ue."userId", ue."stitchedUserId") ORDER BY "addedAt" ASC LIMIT 1
        ) ru ON COALESCE(ue."userId", ue."stitchedUserId") IS NOT NULL
        WHERE ue.at >= ${fromD} AND ue.at <= ${toD}
      )
      SELECT id, at, event, ip, country, region, device, platform, gclid, is_facebook_ads, is_google_ads, eff_rid, eff_uid,
             COUNT(*) OVER()::int AS total
      FROM ev
      WHERE ${cond}
      ORDER BY at DESC
      LIMIT ${LIST_LIMIT}
    `);

    // Header summary — country/region/labels aren't on individual events in the
    // client, so resolve them here (newest non-empty country; first identity).
    const country = rows.find((r) => r.country)?.country ?? "";
    const region = rows.find((r) => r.region)?.region ?? null;
    const effUid = rows.find((r) => r.eff_uid)?.eff_uid ?? null;
    const effRid = rows.find((r) => r.eff_rid)?.eff_rid ?? null;
    const labels = await this.resolveUsageLabels([{ userId: effUid, restaurantId: effRid }]);
    const total = rows.length > 0 ? rows[0].total : 0;
    const hasGoogle = rows.some(
      (r) => r.is_google_ads || r.gclid || r.event.startsWith("l_gclid_"),
    );
    const hasFacebook = rows.some(
      (r) => r.is_facebook_ads || r.event.startsWith("l_fbclid_"),
    );
    const summary = {
      country,
      region,
      userLabel: effUid ? labels.email(effUid) : null,
      restaurantLabel: labels.restaurantName(effRid, effUid),
      eventCount: total,
      truncated: total > LIST_LIMIT,
      hasGoogle,
      hasFacebook,
    };

    return { rows, summary };
  }

  // Resolve a batch of userId / restaurantId to display labels. `email` is the
  // user's email; `restaurantName` always prefers a restaurant TITLE — the
  // event's own restaurantId, else the restaurant attached to the userId (so a
  // session with only a logged-in user still shows a restaurant name, never the
  // bare email).
  private async resolveUsageLabels(
    rows: { userId: string | null; restaurantId: string | null }[],
  ) {
    const userIds = Array.from(
      new Set(rows.map((r) => r.userId).filter((x): x is string => !!x)),
    );
    const directRestaurantIds = rows.map((r) => r.restaurantId).filter((x): x is string => !!x);

    const emails = new Map<string, string>();
    const userRestaurant = new Map<string, string>(); // userId → first attached restaurantId
    if (userIds.length) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
      });
      for (const u of users) emails.set(u.id, u.email);

      const attachments = await this.prisma.restaurantUser.findMany({
        where: { userId: { in: userIds } },
        orderBy: { addedAt: "asc" },
        select: { userId: true, restaurantId: true },
      });
      for (const a of attachments) {
        if (!userRestaurant.has(a.userId)) userRestaurant.set(a.userId, a.restaurantId);
      }
    }

    const allRestaurantIds = Array.from(
      new Set([...directRestaurantIds, ...userRestaurant.values()]),
    );
    const titles = new Map<string, string>();
    if (allRestaurantIds.length) {
      const restaurants = await this.prisma.restaurant.findMany({
        where: { id: { in: allRestaurantIds } },
        select: { id: true, title: true },
      });
      for (const r of restaurants) titles.set(r.id, r.title);
    }

    return {
      email: (userId: string): string | null => emails.get(userId) ?? null,
      restaurantName: (restaurantId: string | null, userId: string | null): string | null => {
        if (restaurantId && titles.get(restaurantId)) return titles.get(restaurantId)!;
        if (userId) {
          const rid = userRestaurant.get(userId);
          if (rid) return titles.get(rid) ?? null;
        }
        return null;
      },
    };
  }

  // ────────────────── META CAPI ──────────────────
  // CAPI conversions are sent fully automatically by CapiService's cron
  // (15-min funnel sweep, cookieless em/external_id match). The manual
  // send/history admin endpoints were removed.

  // ────────────────── SESSION DELETE ──────────────────

  /** Delete whole sessions: for each group descriptor, remove every matching
   *  event within [from, to]. kind 'r' → the restaurant's events; 'a' → the
   *  anonymous ip/region's events. */
  @Post("usage/sessions/delete")
  @HttpCode(HttpStatus.OK)
  async deleteSessions(
    @Body()
    body: {
      from?: string;
      to?: string;
      sessions?: Array<{
        kind?: string;
        rid?: string | null;
        ipkey?: string | null;
        hasIp?: boolean;
      }>;
    },
  ) {
    const list = Array.isArray(body?.sessions) ? body.sessions : [];
    if (list.length === 0) throw new BadRequestException("sessions required");
    if (!body.from || !body.to) throw new BadRequestException("from/to required");
    const fromD = new Date(body.from);
    const toD = new Date(body.to);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
      throw new BadRequestException("from/to invalid");
    }
    let deleted = 0;
    for (const s of list) {
      if (s.kind === "r" && !s.rid) continue;
      // Same effective-restaurant matching as the list/events so deleting an
      // anonymous ip group never removes identified events sharing that ip.
      const cond =
        s.kind === "r"
          ? Prisma.sql`eff_rid = ${s.rid}`
          : Prisma.sql`eff_rid IS NULL AND COALESCE(ip, region) = ${s.ipkey ?? ""}`;
      const r = await this.prisma.$executeRaw(Prisma.sql`
        WITH ev AS (
          SELECT ue.id,
                 COALESCE(ue."manualRestaurantId", ue."restaurantId", ue."stitchedRestaurantId", ru."restaurantId") AS eff_rid,
                 ue.ip, ue.region
          FROM usage_events ue
          LEFT JOIN LATERAL (
            SELECT "restaurantId" FROM restaurant_users
            WHERE "userId" = COALESCE(ue."userId", ue."stitchedUserId") ORDER BY "addedAt" ASC LIMIT 1
          ) ru ON COALESCE(ue."userId", ue."stitchedUserId") IS NOT NULL
          WHERE ue.at >= ${fromD} AND ue.at <= ${toD}
        )
        DELETE FROM usage_events
        WHERE id IN (SELECT id FROM ev WHERE ${cond})
      `);
      deleted += r;
    }
    return { ok: true, deleted };
  }

  // ────────────────── SESSION STITCHING ──────────────────

  /** Attribute anonymous pre-login activity to the user/restaurant that later
   *  logged in from the same device fingerprint. Fingerprint = ip + device +
   *  platform + country + region; events of a fingerprint are split into
   *  islands wherever the gap exceeds 3 days; an island that contains exactly
   *  one identity stamps that identity onto its anonymous events
   *  (stitchedUserId / stitchedRestaurantId). Re-runnable (clears + recomputes). */
  /** Manual trigger (also runs every 5 min via UsageStitchService cron). */
  @Post("usage/stitch")
  @HttpCode(HttpStatus.OK)
  async stitchSessions() {
    return this.stitch.stitch();
  }

  /** Support-chat threads: restaurants with at least one message, newest first. */
  @Get("messages/threads")
  async messageThreads() {
    type Row = {
      rid: string;
      title: string;
      lang: string | null;
      c: number;
      last_at: Date;
      last_msg: string;
      last_admin: boolean;
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT sm."restaurantId" AS rid, r.title, r."defaultLanguage" AS lang,
             count(*)::int AS c,
             max(sm."createdAt") AS last_at,
             (array_agg(sm.message ORDER BY sm."createdAt" DESC))[1] AS last_msg,
             (array_agg(sm."isAdmin" ORDER BY sm."createdAt" DESC))[1] AS last_admin
      FROM support_messages sm
      JOIN restaurants r ON r.id = sm."restaurantId"
      GROUP BY sm."restaurantId", r.title, r."defaultLanguage"
      ORDER BY max(sm."createdAt") DESC
    `);
    return {
      threads: rows.map((r) => ({
        restaurantId: r.rid,
        title: r.title,
        defaultLanguage: r.lang,
        count: r.c,
        lastMessage: r.last_msg,
        lastAt: r.last_at.toISOString(),
        lastFromAdmin: r.last_admin,
      })),
    };
  }

  /** Restaurants for the manual session-assign picker. */
  @Get("usage/restaurants")
  async usageRestaurants() {
    const rs = await this.prisma.restaurant.findMany({
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    });
    return { restaurants: rs };
  }

  /** Manually merge a session into a restaurant: stamp manualRestaurantId
   *  (highest precedence) onto the session's events so they regroup under it. */
  @Post("usage/sessions/assign")
  @HttpCode(HttpStatus.OK)
  async assignSession(
    @Body()
    body: { kind?: string; rid?: string | null; ipkey?: string | null; from?: string; to?: string; restaurantId?: string },
  ) {
    const restaurantId = (body.restaurantId ?? "").trim();
    if (!restaurantId) throw new BadRequestException("restaurantId required");
    if (!body.from || !body.to) throw new BadRequestException("from/to required");
    const fromD = new Date(body.from);
    const toD = new Date(body.to);
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
      throw new BadRequestException("from/to invalid");
    }
    const cond =
      body.kind === "r"
        ? Prisma.sql`eff_rid = ${body.rid}`
        : Prisma.sql`eff_rid IS NULL AND COALESCE(ip, region) = ${body.ipkey ?? ""}`;
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      WITH ev AS (
        SELECT ue.id,
               COALESCE(ue."manualRestaurantId", ue."restaurantId", ue."stitchedRestaurantId", ru."restaurantId") AS eff_rid,
               ue.ip, ue.region
        FROM usage_events ue
        LEFT JOIN LATERAL (
          SELECT "restaurantId" FROM restaurant_users
          WHERE "userId" = COALESCE(ue."userId", ue."stitchedUserId") ORDER BY "addedAt" ASC LIMIT 1
        ) ru ON COALESCE(ue."userId", ue."stitchedUserId") IS NOT NULL
        WHERE ue.at >= ${fromD} AND ue.at <= ${toD}
      )
      UPDATE usage_events SET "manualRestaurantId" = ${restaurantId}
      WHERE id IN (SELECT id FROM ev WHERE ${cond})
    `);
    return { ok: true, updated };
  }

}
