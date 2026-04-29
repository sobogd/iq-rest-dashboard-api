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
import { PrismaService } from "../prisma/prisma.service";
import { AdminGuard } from "./admin.guard";
import { AuthService } from "../auth/auth.service";
import { authCookieOptions, generateSessionToken, hashSessionToken } from "../common/session-utils";
import type { AuthedRequest } from "../auth/auth.guard";

const SESSION_COOKIE = "iqr_session";
const EMAIL_COOKIE = "iqr_email";
const ADMIN_ORIG_SESSION = "iqr_admin_original_session";
const ADMIN_ORIG_EMAIL = "iqr_admin_original_email";
const ADMIN_ORIG_USER_ID = "iqr_admin_original_user_id";

interface ListQuery {
  filter?: string;
  tz?: string;
}

@Controller("admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  // ────────────────── COMPANIES ──────────────────

  @Get("companies")
  async listCompanies(@Query() query: ListQuery) {
    const filter = query.filter || "all";
    const tz = query.tz || "UTC";
    const todayStart = startOfDayInTz(tz);
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    let todayActiveIds: Set<string> | null = null;
    if (filter === "today_active") {
      const rows = await this.prisma.$queryRaw<{ companyId: string }[]>`
        SELECT DISTINCT "companyId"
        FROM page_views
        WHERE "createdAt" >= ${todayStart}
      `;
      todayActiveIds = new Set(rows.map((r) => r.companyId));
      if (todayActiveIds.size === 0) return { companies: [], total: 0 };
    }

    const where: Record<string, unknown> = {};
    if (todayActiveIds) where.id = { in: [...todayActiveIds] };

    const companies = await this.prisma.company.findMany({
      where,
      select: {
        id: true,
        plan: true,
        scanLimit: true,
        subscriptionStatus: true,
        emailsSent: true,
        restaurants: { select: { title: true }, take: 1 },
        _count: { select: { categories: true, items: true, supportMessages: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const ids = companies.map((c) => c.id);
    const [monthly, today] = ids.length
      ? await Promise.all([
          this.prisma.$queryRaw<{ companyId: string; count: bigint }[]>`
            SELECT "companyId", COUNT(DISTINCT "sessionId") AS count
            FROM page_views
            WHERE "companyId" = ANY(${ids}::text[])
              AND "createdAt" >= ${startOfMonth}
            GROUP BY "companyId"
          `,
          this.prisma.$queryRaw<{ companyId: string; count: bigint }[]>`
            SELECT "companyId", COUNT(DISTINCT "sessionId") AS count
            FROM page_views
            WHERE "companyId" = ANY(${ids}::text[])
              AND "createdAt" >= ${todayStart}
            GROUP BY "companyId"
          `,
        ])
      : [[], []];
    const monthlyMap = new Map(monthly.map((r) => [r.companyId, Number(r.count)]));
    const todayMap = new Map(today.map((r) => [r.companyId, Number(r.count)]));

    const items = companies.map((c) => ({
      id: c.id,
      name: c.restaurants[0]?.title || null,
      plan: c.plan,
      subscriptionStatus: c.subscriptionStatus,
      categoriesCount: c._count.categories,
      itemsCount: c._count.items,
      messagesCount: c._count.supportMessages,
      monthlyViews: monthlyMap.get(c.id) || 0,
      todayViews: todayMap.get(c.id) || 0,
      scanLimit: c.plan === "FREE" ? c.scanLimit : null,
      emailsSent: c.emailsSent,
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

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const [monthlyViews, session] = await Promise.all([
      this.prisma.pageView.count({ where: { companyId: id, createdAt: { gte: startOfMonth } } }),
      this.prisma.session.findFirst({
        where: { companyId: id },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      }),
    ]);

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
      monthlyViews,
      scanLimit: company.scanLimit,
      sessionId: session?.id || null,
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

  @Post("companies/:id/messages")
  async sendMessage(
    @Req() req: Request,
    @Param("id") companyId: string,
    @Body() body: { message?: string },
  ) {
    const adminEmail = (req as AuthedRequest).authUser.email;
    const text = (body.message ?? "").trim();
    if (!text) throw new BadRequestException("Message is required");
    if (text.length > 2000) throw new BadRequestException("Message too long");

    const adminUser = await this.prisma.user.findUnique({ where: { email: adminEmail } });
    if (!adminUser) throw new NotFoundException("Admin user not found");

    return this.prisma.supportMessage.create({
      data: { message: text, companyId, userId: adminUser.id, isAdmin: true },
      select: {
        id: true,
        message: true,
        isAdmin: true,
        createdAt: true,
        user: { select: { email: true } },
      },
    });
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

    // Save admin originals so we can restore on exit.
    res.cookie(ADMIN_ORIG_SESSION, adminSession, { ...opts, httpOnly: true });
    res.cookie(ADMIN_ORIG_EMAIL, adminAuth.email, { ...opts, httpOnly: true });
    res.cookie(ADMIN_ORIG_USER_ID, adminAuth.userId, { ...opts, httpOnly: true });

    // Issue a fresh session for the target user (overwrites their existing token).
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    await this.prisma.user.update({
      where: { id: target.id },
      data: { sessionToken: tokenHash },
    });

    res.cookie(SESSION_COOKIE, token, opts);
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

  // ────────────────── ANALYTICS ──────────────────

  @Get("analytics/sessions-list")
  async sessionsList(@Query("period") period = "today", @Query("tz") tz = "UTC") {
    const { dateFrom, dateTo } = computeDateRange(period, tz);
    const dateFilter = dateTo ? { gte: dateFrom, lt: dateTo } : { gte: dateFrom };

    const sessionsList = await this.prisma.session.findMany({
      where: { events: { some: { createdAt: dateFilter } } },
      select: {
        id: true,
        country: true,
        gclid: true,
        userId: true,
        lastSeenAt: true,
        createdAt: true,
        _count: { select: { events: true } },
        events: { orderBy: { createdAt: "asc" }, select: { createdAt: true } },
      },
    });

    const MAX_GAP_MS = 10 * 60 * 1000;
    sessionsList.sort((a, b) => {
      const aLast = a.events[a.events.length - 1]?.createdAt ?? a.createdAt;
      const bLast = b.events[b.events.length - 1]?.createdAt ?? b.createdAt;
      return bLast.getTime() - aLast.getTime();
    });

    const sessions = sessionsList.map((s) => {
      const lastEvent = s.events[s.events.length - 1]?.createdAt ?? s.createdAt;
      let active = 0;
      for (let i = 1; i < s.events.length; i++) {
        const gap = s.events[i].createdAt.getTime() - s.events[i - 1].createdAt.getTime();
        active += Math.min(gap, MAX_GAP_MS);
      }
      return {
        sessionId: s.id,
        lastEvent: lastEvent.toISOString(),
        duration: Math.round(active / 1000),
        eventCount: s._count.events,
        country: s.country,
        source: s.gclid ? "Ads" : "Direct",
        hasUser: !!s.userId,
        lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
      };
    });

    return { sessions };
  }

  @Get("analytics/sessions")
  async sessions(
    @Query("event") event?: string,
    @Query("sessionId") sessionId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("country") country?: string,
  ) {
    if (sessionId) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          events: {
            orderBy: { createdAt: "asc" },
            select: { id: true, event: true, sessionId: true, meta: true, createdAt: true },
          },
        },
      });
      let restaurantName: string | null = null;
      if (session?.companyId) {
        const r = await this.prisma.restaurant.findFirst({
          where: { companyId: session.companyId },
          select: { title: true },
        });
        restaurantName = r?.title ?? null;
      }
      return {
        session: session
          ? {
              id: session.id,
              companyId: session.companyId,
              country: session.country,
              city: session.city,
              landingPage: session.landingPage,
              gclid: session.gclid,
              keyword: session.keyword,
              userAgent: session.userAgent,
              browser: session.browser,
              device: session.device,
              ip: session.ip,
              restaurantName,
              wasRegistered: session.wasRegistered,
              namedRestaurant: session.namedRestaurant,
              selectedType: session.selectedType,
              modifiedMenu: session.modifiedMenu,
              modifiedContacts: session.modifiedContacts,
              modifiedDesign: session.modifiedDesign,
              reached50Views: session.reached50Views,
              paidSubscription: session.paidSubscription,
              conversionSent: session.conversionSent,
              conversionViewsSent: session.conversionViewsSent,
              conversionSubscriptionSent: session.conversionSubscriptionSent,
              lastSeenAt: session.lastSeenAt,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            }
          : null,
        events: session?.events || [],
      };
    }

    const dateFrom = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dateTo = to ? new Date(to) : new Date();
    const where: Record<string, unknown> = { createdAt: { gte: dateFrom, lte: dateTo } };
    if (country) where.country = country;

    let sessionIdFilter: string[] | undefined;
    if (event) {
      const matching = await this.prisma.analyticsEvent.findMany({
        where: { event, createdAt: { gte: dateFrom, lte: dateTo } },
        distinct: ["sessionId"],
        select: { sessionId: true },
        take: 100,
      });
      sessionIdFilter = matching.map((m) => m.sessionId);
      if (sessionIdFilter.length === 0) return { sessions: [] };
      where.id = { in: sessionIdFilter };
    }

    const sessions = await this.prisma.session.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        userId: true,
        country: true,
        gclid: true,
        browser: true,
        device: true,
        ip: true,
        createdAt: true,
        _count: { select: { events: true } },
        events: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
      },
    });

    sessions.sort((a, b) => {
      const aLast = a.events[0]?.createdAt ?? a.createdAt;
      const bLast = b.events[0]?.createdAt ?? b.createdAt;
      return new Date(bLast).getTime() - new Date(aLast).getTime();
    });

    const sessionIds = sessions.map((s) => s.id);
    const eventTypes = await this.prisma.analyticsEvent.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true, event: true },
    });
    const typeMap = new Map<string, "signup" | "dashboard" | null>();
    for (const evt of eventTypes) {
      const cur = typeMap.get(evt.sessionId);
      if (evt.event === "auth_signup") typeMap.set(evt.sessionId, "signup");
      else if (
        evt.event.startsWith("showed_") &&
        evt.event !== "showed_login" &&
        evt.event !== "showed_otp" &&
        evt.event !== "showed_onboarding_name" &&
        cur !== "signup"
      ) {
        typeMap.set(evt.sessionId, "dashboard");
      }
    }

    return {
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        userId: s.userId,
        createdAt: s.createdAt,
        lastEventAt: s.events[0]?.createdAt ?? s.createdAt,
        meta: s.country ? { geo: { country: s.country } } : null,
        source: s.gclid ? "Ads" : "Direct",
        adValues: undefined,
        sessionType: typeMap.get(s.id) || null,
        eventCount: s._count.events,
      })),
    };
  }

  @Delete("analytics/sessions")
  @HttpCode(HttpStatus.OK)
  async deleteSession(@Body() body: { sessionId?: string }) {
    if (!body.sessionId) throw new BadRequestException("sessionId required");
    await this.prisma.session
      .delete({ where: { id: body.sessionId } })
      .catch(() => this.prisma.analyticsEvent.deleteMany({ where: { sessionId: body.sessionId } }));
    return { success: true };
  }

  @Post("analytics/send-conversion")
  async sendConversion() {
    // Stub — Google Ads upload not configured in this deployment.
    return { success: false, error: "Google Ads conversion upload not configured" };
  }
}

// ────────────────── helpers ──────────────────

function startOfDayInTz(tz: string): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value) - 1;
  const d = Number(parts.find((p) => p.type === "day")!.value);
  const todayLocal = new Date(Date.UTC(y, m, d));
  const utcStr = todayLocal.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = todayLocal.toLocaleString("en-US", { timeZone: tz });
  const offsetMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();
  return new Date(todayLocal.getTime() + offsetMs);
}

function computeDateRange(period: string, tz: string): { dateFrom: Date; dateTo?: Date } {
  const todayStart = startOfDayInTz(tz);
  if (period === "yesterday") {
    return { dateFrom: new Date(todayStart.getTime() - 86400000), dateTo: todayStart };
  }
  if (period === "7days") {
    return { dateFrom: new Date(todayStart.getTime() - 7 * 86400000) };
  }
  return { dateFrom: todayStart };
}
