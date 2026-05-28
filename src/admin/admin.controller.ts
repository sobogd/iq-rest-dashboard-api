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
  ) {}

  // ────────────────── DEVICES ──────────────────

  // Fan out a force-reload to every paired tablet across every company.
  // Used after deploying an urgent kitchen-bundle fix — the kiosk SSE
  // handler clears its caches and calls location.reload() on receipt.
  @Post("devices/reload-all")
  reloadAllDevices() {
    return this.devices.reloadAllGlobal();
  }

  // ────────────────── COMPANIES ──────────────────

  @Get("companies")
  async listCompanies(@Query() _query: ListQuery) {
    const now = new Date();
    // 30-day rolling window aligned to UTC day boundaries so this list and
    // the analytics dashboard agree on the same window for an entire calendar
    // day. Window: [today_utc_midnight - 29d, tomorrow_utc_midnight) — 30
    // calendar days, today inclusive.
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const DAY_MS = 24 * 60 * 60 * 1000;
    const upper30d = new Date(todayUtc.getTime() + DAY_MS);
    const startOf30d = new Date(upper30d.getTime() - 30 * DAY_MS);
    const startOf45d = new Date(upper30d.getTime() - 45 * DAY_MS);
    const startOf60d = new Date(upper30d.getTime() - 60 * DAY_MS);
    const startOf85d = new Date(upper30d.getTime() - 85 * DAY_MS);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const companies = await this.prisma.company.findMany({
      select: {
        id: true,
        plan: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        emailsSent: true,
        restaurants: { select: { title: true }, take: 1 },
        _count: { select: { categories: true, items: true, supportMessages: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const ids = companies.map((c) => c.id);
    const startOfMessagesLastDay = new Date(now.getTime() - DAY_MS);
    const [monthly, today, d45, d60, d85, lastVisits, messagesLastDay] = ids.length
      ? await Promise.all([
          this.prisma.$queryRaw<{ companyId: string; count: bigint }[]>`
            SELECT "companyId", COUNT(DISTINCT "sessionId") AS count
            FROM page_views
            WHERE "companyId" = ANY(${ids}::text[])
              AND "createdAt" >= ${startOf30d}
              AND "createdAt" < ${upper30d}
            GROUP BY "companyId"
          `,
          this.prisma.$queryRaw<{ companyId: string; count: bigint }[]>`
            SELECT "companyId", COUNT(DISTINCT "sessionId") AS count
            FROM page_views
            WHERE "companyId" = ANY(${ids}::text[])
              AND "createdAt" >= ${startOfDay}
            GROUP BY "companyId"
          `,
          this.prisma.$queryRaw<{ companyId: string; count: bigint }[]>`
            SELECT "companyId", COUNT(DISTINCT "sessionId") AS count
            FROM page_views
            WHERE "companyId" = ANY(${ids}::text[])
              AND "createdAt" >= ${startOf45d}
              AND "createdAt" < ${upper30d}
            GROUP BY "companyId"
          `,
          this.prisma.$queryRaw<{ companyId: string; count: bigint }[]>`
            SELECT "companyId", COUNT(DISTINCT "sessionId") AS count
            FROM page_views
            WHERE "companyId" = ANY(${ids}::text[])
              AND "createdAt" >= ${startOf60d}
              AND "createdAt" < ${upper30d}
            GROUP BY "companyId"
          `,
          this.prisma.$queryRaw<{ companyId: string; count: bigint }[]>`
            SELECT "companyId", COUNT(DISTINCT "sessionId") AS count
            FROM page_views
            WHERE "companyId" = ANY(${ids}::text[])
              AND "createdAt" >= ${startOf85d}
              AND "createdAt" < ${upper30d}
            GROUP BY "companyId"
          `,
          this.prisma.$queryRaw<{ companyId: string; last: Date | null }[]>`
            SELECT "companyId", MAX(at) AS last
            FROM usage_events
            WHERE "companyId" = ANY(${ids}::text[])
            GROUP BY "companyId"
          `,
          this.prisma.supportMessage.groupBy({
            by: ["companyId"],
            where: { companyId: { in: ids }, isAdmin: false, createdAt: { gte: startOfMessagesLastDay } },
            _count: { _all: true },
          }),
        ])
      : [[], [], [], [], [], [], []];
    const monthlyMap = new Map(monthly.map((r) => [r.companyId, Number(r.count)]));
    const todayMap = new Map(today.map((r) => [r.companyId, Number(r.count)]));
    const d45Map = new Map(d45.map((r) => [r.companyId, Number(r.count)]));
    const d60Map = new Map(d60.map((r) => [r.companyId, Number(r.count)]));
    const d85Map = new Map(d85.map((r) => [r.companyId, Number(r.count)]));
    const lastVisitMap = new Map(lastVisits.map((r) => [r.companyId, r.last]));
    const messagesLastDayMap = new Map(
      (messagesLastDay as Array<{ companyId: string; _count: { _all: number } }>).map(
        (r) => [r.companyId, r._count._all] as const,
      ),
    );

    const items = companies.map((c) => ({
      id: c.id,
      name: c.restaurants[0]?.title || null,
      plan: c.plan,
      subscriptionStatus: c.subscriptionStatus,
      trialEndsAt: c.trialEndsAt?.toISOString() ?? null,
      categoriesCount: c._count.categories,
      itemsCount: c._count.items,
      messagesCount: c._count.supportMessages,
      messagesLastDayCount: messagesLastDayMap.get(c.id) || 0,
      monthlyViews: monthlyMap.get(c.id) || 0,
      todayScans: todayMap.get(c.id) || 0,
      scans45d: d45Map.get(c.id) || 0,
      scans60d: d60Map.get(c.id) || 0,
      scans85d: d85Map.get(c.id) || 0,
      lastVisit: lastVisitMap.get(c.id)?.toISOString() ?? null,
      emailsSent: c.emailsSent,
      emailsSentCount:
        c.emailsSent && typeof c.emailsSent === "object" && !Array.isArray(c.emailsSent)
          ? Object.keys(c.emailsSent).length
          : 0,
    }));

    return { companies: items, total: items.length };
  }

  @Get("companies/:id")
  async getCompany(@Param("id") id: string) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        users: { include: { user: { select: { id: true, email: true, createdAt: true } } } },
        restaurants: {
          select: {
            id: true, title: true, description: true, slug: true, accentColor: true,
            createdAt: true, address: true, phone: true, instagram: true, whatsapp: true,
            reservationsEnabled: true, defaultLanguage: true, languages: true,
          },
        },
        _count: { select: { categories: true, items: true, supportMessages: true } },
      },
    });
    if (!company) throw new NotFoundException("Company not found");

    const menuOrigin = process.env.PUBLIC_MENU_URL || "https://iq-rest.com";

    return {
      id: company.id,
      name: company.name,
      createdAt: company.createdAt,
      plan: company.plan,
      subscriptionStatus: company.subscriptionStatus,
      billingCycle: company.billingCycle,
      currentPeriodEnd: company.currentPeriodEnd,
      stripeCustomerId: company.stripeCustomerId,
      stripeSubscriptionId: company.stripeSubscriptionId,
      emailsSent: company.emailsSent,
      categoriesCount: company._count.categories,
      itemsCount: company._count.items,
      messagesCount: company._count.supportMessages,
      users: company.users.map((uc) => ({
        id: uc.user.id,
        email: uc.user.email,
        createdAt: uc.user.createdAt,
        role: uc.role,
      })),
      restaurants: company.restaurants.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        slug: r.slug,
        accentColor: r.accentColor,
        createdAt: r.createdAt,
        address: r.address,
        phone: r.phone,
        instagram: r.instagram,
        whatsapp: r.whatsapp,
        reservationsEnabled: r.reservationsEnabled,
        defaultLanguage: r.defaultLanguage,
        languages: r.languages,
        url: r.slug ? `${menuOrigin.replace(/\/$/, "")}/m/${r.slug}` : null,
      })),
    };
  }

  @Delete("companies/:id")
  @HttpCode(HttpStatus.OK)
  async deleteCompany(@Param("id") id: string) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: { users: true },
    });
    if (!company) throw new NotFoundException("Company not found");

    await this.prisma.company.delete({ where: { id } });

    for (const uc of company.users) {
      const others = await this.prisma.userCompany.count({ where: { userId: uc.userId } });
      if (others === 0) {
        await this.prisma.user.delete({ where: { id: uc.userId } }).catch(() => undefined);
      }
    }
    return { success: true };
  }

  // ────────────────── RESTAURANT GRANTS ──────────────────
  // Cross-company access: grant a user (by email) the right to manage a
  // restaurant owned by another company. The restaurant's owner is unchanged;
  // AuthGuard derives the active company from the selected restaurant and
  // flags it viaGrant (billing + delete hidden). See RestaurantAccess model.

  @Get("restaurant-grants")
  async listRestaurantGrants() {
    const grants = await this.prisma.restaurantAccess.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true } },
        restaurant: {
          select: { id: true, title: true, slug: true, company: { select: { id: true, name: true } } },
        },
      },
    });
    return grants.map((g) => ({
      id: g.id,
      role: g.role,
      createdAt: g.createdAt.toISOString(),
      userId: g.user.id,
      userEmail: g.user.email,
      restaurantId: g.restaurant.id,
      restaurantTitle: g.restaurant.title,
      restaurantSlug: g.restaurant.slug,
      ownerCompanyId: g.restaurant.company.id,
      ownerCompanyName: g.restaurant.company.name,
    }));
  }

  // Searchable restaurant picker for the grant form (title/slug, max 50).
  @Get("restaurant-grants/restaurants")
  async grantRestaurantOptions(@Query("q") q = "") {
    const term = (q || "").trim();
    const restaurants = await this.prisma.restaurant.findMany({
      where: term
        ? {
            OR: [
              { title: { contains: term, mode: "insensitive" } },
              { slug: { contains: term, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, title: true, slug: true, company: { select: { id: true, name: true } } },
    });
    return restaurants.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      companyId: r.company.id,
      companyName: r.company.name,
    }));
  }

  @Post("restaurant-grants")
  async createRestaurantGrant(
    @Body() body: { email?: string; restaurantId?: string; role?: string },
  ) {
    const email = validateEmail(body.email);
    const restaurantId = (body.restaurantId || "").trim();
    if (!email) throw new BadRequestException("Valid email required");
    if (!restaurantId) throw new BadRequestException("restaurantId required");

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, companyId: true },
    });
    if (!restaurant) throw new NotFoundException("Restaurant not found");

    // Find or create the grantee. A brand-new user gets an empty company
    // (onboardingStep already complete, NO seeded restaurant) so resolveSession
    // works and their first OTP login lands straight on the granted restaurant.
    let user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) {
      user = await this.prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: { email } });
        const c = await tx.company.create({ data: { name: "Guest", onboardingStep: 3 } });
        await tx.userCompany.create({ data: { userId: u.id, companyId: c.id, role: "owner" } });
        return { id: u.id };
      });
    }

    // Block granting a restaurant the user already owns (their own company) —
    // that would be a no-op self-grant and confuse the owned/viaGrant logic.
    const ownsIt = await this.prisma.userCompany.findFirst({
      where: { userId: user.id, companyId: restaurant.companyId },
      select: { id: true },
    });
    if (ownsIt) {
      throw new BadRequestException("User already owns this restaurant's company");
    }

    const grant = await this.prisma.restaurantAccess.upsert({
      where: { userId_restaurantId: { userId: user.id, restaurantId } },
      create: { userId: user.id, restaurantId, role: body.role || "manager" },
      update: { role: body.role || "manager" },
      select: { id: true },
    });
    return { id: grant.id, userId: user.id };
  }

  @Delete("restaurant-grants/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRestaurantGrant(@Param("id") id: string) {
    await this.prisma.restaurantAccess.delete({ where: { id } }).catch(() => {
      throw new NotFoundException("Grant not found");
    });
  }

  // ────────────────── RESTAURANTS (per-restaurant billing UI) ──────────────────

  // Flat list of every restaurant in the system with the aggregates the admin
  // table needs. Replaces the Company-centred list as the primary admin view.
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
        companyId: true,
        plan: true,
        subscriptionStatus: true,
        billingCycle: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        stripeSubscriptionId: true,
        createdAt: true,
        company: { select: { name: true, plan: true, subscriptionStatus: true, trialEndsAt: true } },
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
        // Per-restaurant plan/status with legacy Company fallback during transition.
        const plan = r.plan ?? r.company.plan ?? "FREE";
        const subscriptionStatus = r.subscriptionStatus ?? r.company.subscriptionStatus ?? "INACTIVE";
        const trialEndsAt = r.trialEndsAt ?? r.company.trialEndsAt ?? null;
        const isManualSub =
          subscriptionStatus === "ACTIVE" && !r.stripeSubscriptionId;
        return {
          id: r.id,
          title: r.title,
          slug: r.slug,
          companyId: r.companyId,
          companyName: r.company.name,
          plan,
          billingCycle: r.billingCycle,
          subscriptionStatus,
          trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
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

  // Attach an existing user to a restaurant (formerly a "grant"). Type-ahead
  // search returns existing users only; signup for a brand-new email happens
  // through the normal OTP flow first.
  @Post("restaurants/:id/users")
  async attachUserToRestaurant(
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

    const ru = await this.prisma.restaurantUser.upsert({
      where: { restaurantId_userId: { restaurantId, userId: user.id } },
      create: { restaurantId, userId: user.id },
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
  // "what does this person own/manage" without drilling into Company.
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
        // Legacy fallback for users with no restaurantUsers row yet (mid-rollout
        // edge case where backfill missed them — should be empty after deploy).
        companies: {
          select: { company: { select: { restaurants: { select: { id: true } } } } },
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

  // ────────────────── COMPANY MESSAGES ──────────────────

  @Get("companies/:id/messages")
  async listMessages(@Param("id") companyId: string) {
    return this.prisma.supportMessage.findMany({
      where: { companyId },
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

  /** Manually trigger an email template to a company's primary owner.
   *  Records the send in Company.emailsSent JSON for tracking + idempotency hint. */
  @Post("companies/:id/send-email")
  async sendEmail(
    @Param("id") companyId: string,
    @Body() body: { template?: string; locale?: string },
  ) {
    const template = body.template;
    if (template !== "welcome_personal" && template !== "menu_almost_ready" && template !== "trial_ending") {
      throw new BadRequestException("Unknown template");
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        users: {
          orderBy: { user: { createdAt: "asc" } },
          take: 1,
          include: { user: { select: { email: true, preferredLocale: true } } },
        },
        restaurants: { take: 1, select: { title: true, defaultLanguage: true } },
      },
    });
    if (!company) throw new NotFoundException("Company not found");

    const owner = company.users[0]?.user;
    if (!owner?.email) throw new BadRequestException("Owner email not found");
    if (company.emailUnsubscribed) throw new BadRequestException("Owner unsubscribed");

    const restaurant = company.restaurants[0];
    // Admin-supplied locale wins. Falls back to the user's preference, then
    // the restaurant default, then "en". Validation is loose — i18n templates
    // already fall back to "en" for unknown locales.
    const requestedLocale = (body.locale ?? "").trim().toLowerCase();
    const locale = requestedLocale || owner.preferredLocale || restaurant?.defaultLanguage || "en";
    const name = restaurant?.title || owner.email.split("@")[0];

    if (template === "welcome_personal") {
      await this.mail.sendWelcomePersonal({ email: owner.email, name, locale });
    } else if (template === "trial_ending") {
      await this.mail.sendTrialEnding({ email: owner.email, name, locale });
    } else {
      await this.mail.sendMenuAlmostReady({ email: owner.email, name, locale });
    }

    // Record in emailsSent JSON: { welcome_personal: "ISO timestamp" }
    const existing =
      company.emailsSent && typeof company.emailsSent === "object" && !Array.isArray(company.emailsSent)
        ? (company.emailsSent as Record<string, string>)
        : {};
    const updated = { ...existing, [template]: new Date().toISOString() };
    await this.prisma.company.update({
      where: { id: companyId },
      data: { emailsSent: updated },
    });

    return { ok: true, template, sentAt: updated[template], to: owner.email, locale };
  }

  @Post("companies/:id/messages")
  async sendMessage(
    @Req() req: Request,
    @Param("id") companyId: string,
    @Body() body: { message?: string; locale?: string },
  ) {
    const adminEmail = (req as AuthedRequest).authUser.email;
    const text = (body.message ?? "").trim();
    if (!text) throw new BadRequestException("Message is required");
    if (text.length > 2000) throw new BadRequestException("Message too long");

    const adminUser = await this.prisma.user.findUnique({ where: { email: adminEmail } });
    if (!adminUser) throw new NotFoundException("Admin user not found");

    const created = await this.prisma.supportMessage.create({
      data: { message: text, companyId, userId: adminUser.id, isAdmin: true },
      select: {
        id: true,
        message: true,
        isAdmin: true,
        createdAt: true,
        user: { select: { email: true } },
      },
    });

    // Notify the company owner by email (best-effort). Prefer the user's last
    // dashboard locale; fall back to the restaurant's menu language, then en.
    const companyForEmail = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        users: {
          take: 1,
          include: { user: { select: { email: true, preferredLocale: true } } },
        },
        restaurants: { take: 1, select: { defaultLanguage: true } },
      },
    });
    const owner = companyForEmail?.users[0]?.user;
    const clientEmail = owner?.email;
    const requestedLocale = (body.locale ?? "").trim().toLowerCase();
    const locale =
      requestedLocale ||
      owner?.preferredLocale ||
      companyForEmail?.restaurants[0]?.defaultLanguage ||
      "en";
    if (clientEmail) {
      this.mail
        .sendSupportReplyNotification(clientEmail, locale)
        .catch((err) => console.error("support email failed:", err));
    }

    return created;
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
      include: { companies: { include: { company: true }, take: 1 } },
    });
    if (!target || !target.companies[0]) throw new NotFoundException("User not found");

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
    @Query("companyId") companyId?: string,
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
    if (companyId) {
      where.companyId = companyId;
    } else if (scope === "anonymous") {
      where.companyId = null;
    } else if (scope === "identified") {
      where.companyId = { not: null };
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
        companyId: true,
        ip: true,
        is_search: true,
        is_google_ads: true,
        is_facebook_ads: true,
        fbSentEvents: true,
      },
    });

    // Resolve companyId → friendly label (first restaurant title, or first user
    // email). Single batched query keeps the endpoint cheap.
    const companyIds = Array.from(new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x)));
    const labels = new Map<string, string>();
    if (companyIds.length) {
      const companies = await this.prisma.company.findMany({
        where: { id: { in: companyIds } },
        select: {
          id: true,
          restaurants: { select: { title: true }, take: 1, orderBy: { createdAt: "asc" } },
          users: {
            select: { user: { select: { email: true } } },
            take: 1,
            orderBy: { createdAt: "asc" },
          },
        },
      });
      for (const c of companies) {
        const restaurantTitle = c.restaurants[0]?.title?.trim();
        const userEmail = c.users[0]?.user.email;
        const label = restaurantTitle || userEmail || c.id;
        labels.set(c.id, label);
      }
    }

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
        companyId: r.companyId,
        companyLabel: r.companyId ? labels.get(r.companyId) ?? null : null,
        ip: r.ip,
        isSearch: r.is_search,
        isGoogleAds: r.is_google_ads,
        isFacebookAds: r.is_facebook_ads,
        fbSentEvents: r.fbSentEvents,
      })),
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
        gclid: true, ad_params: true, companyId: true, ip: true,
        is_search: true, is_google_ads: true, is_facebook_ads: true,
        fbSentEvents: true,
      },
    });

    const companyIds = Array.from(new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x)));
    const labels = new Map<string, string>();
    if (companyIds.length) {
      const companies = await this.prisma.company.findMany({
        where: { id: { in: companyIds } },
        select: {
          id: true,
          restaurants: { select: { title: true }, take: 1, orderBy: { createdAt: "asc" } },
          users: { select: { user: { select: { email: true } } }, take: 1, orderBy: { createdAt: "asc" } },
        },
      });
      for (const c of companies) {
        const label = c.restaurants[0]?.title?.trim() || c.users[0]?.user.email || c.id;
        labels.set(c.id, label);
      }
    }

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
        companyId: r.companyId,
        companyLabel: r.companyId ? labels.get(r.companyId) ?? null : null,
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

  @Post("usage/events/link-company")
  @HttpCode(HttpStatus.OK)
  async bulkLinkCompany(@Body() body: { ids?: string[]; companyId?: string }) {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((s) => typeof s === "string" && s.length > 0) : [];
    if (ids.length === 0) throw new BadRequestException("ids required");
    const companyId = typeof body?.companyId === "string" ? body.companyId : "";
    if (!companyId) throw new BadRequestException("companyId required");
    const exists = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!exists) throw new BadRequestException("Unknown company");
    const r = await this.prisma.usageEvent.updateMany({
      where: { id: { in: ids } },
      data: { companyId },
    });
    return { ok: true, updated: r.count };
  }

}
