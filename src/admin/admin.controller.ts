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
import { MailService } from "../mail/mail.service";
import { authCookieOptions } from "../common/session-utils";
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
    private readonly mail: MailService,
  ) {}

  // ────────────────── COMPANIES ──────────────────

  @Get("companies")
  async listCompanies(@Query() query: ListQuery) {
    const filter = query.filter || "all";
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    // "active" = company has menu scans (page views) within the last 30 days.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const where =
      filter === "active"
        ? { pageViews: { some: { createdAt: { gte: thirtyDaysAgo } } } }
        : {};

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
    const [monthly, lastVisits] = ids.length
      ? await Promise.all([
          this.prisma.$queryRaw<{ companyId: string; count: bigint }[]>`
            SELECT "companyId", COUNT(DISTINCT "sessionId") AS count
            FROM page_views
            WHERE "companyId" = ANY(${ids}::text[])
              AND "createdAt" >= ${startOfMonth}
            GROUP BY "companyId"
          `,
          this.prisma.$queryRaw<{ companyId: string; last: Date | null }[]>`
            SELECT s."companyId", MAX(e."occurredAt") AS last
            FROM sessions s
            LEFT JOIN analytics_events e ON e."sessionId" = s."id"
            WHERE s."companyId" = ANY(${ids}::text[])
            GROUP BY s."companyId"
          `,
        ])
      : [[], []];
    const monthlyMap = new Map(monthly.map((r) => [r.companyId, Number(r.count)]));
    const lastVisitMap = new Map(lastVisits.map((r) => [r.companyId, r.last]));

    const items = companies.map((c) => ({
      id: c.id,
      name: c.restaurants[0]?.title || null,
      plan: c.plan,
      subscriptionStatus: c.subscriptionStatus,
      categoriesCount: c._count.categories,
      itemsCount: c._count.items,
      messagesCount: c._count.supportMessages,
      monthlyViews: monthlyMap.get(c.id) || 0,
      lastVisit: lastVisitMap.get(c.id)?.toISOString() ?? null,
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
        orderBy: { createdAt: "desc" },
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
    const locale =
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

  // ────────────────── ANALYTICS ──────────────────

  @Get("analytics/sessions-list")
  async sessionsList(
    @Query("period") period = "today",
    @Query("tz") tz = "UTC",
    @Query("offset") offsetRaw = "0",
    @Query("limit") limitRaw = "100",
  ) {
    const { dateFrom, dateTo } = computeDateRange(period, tz);
    const dateFilter = dateTo ? { gte: dateFrom, lt: dateTo } : { gte: dateFrom };
    const offset = Math.max(0, parseInt(offsetRaw, 10) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(limitRaw, 10) || 100));

    const dateLte = dateTo ?? new Date();
    const total = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT "sessionId") AS count
      FROM analytics_events
      WHERE "occurredAt" >= ${dateFrom} AND "occurredAt" < ${dateLte}
    `;
    const totalCount = Number(total[0]?.count ?? 0);

    // One pass: aggregate first/last/count per session within the window.
    const aggregates = await this.prisma.$queryRaw<
      { sessionId: string; first: Date; last: Date; count: bigint }[]
    >`
      SELECT "sessionId",
             MIN("occurredAt") AS first,
             MAX("occurredAt") AS last,
             COUNT(*) AS count
      FROM analytics_events
      WHERE "occurredAt" >= ${dateFrom} AND "occurredAt" < ${dateLte}
      GROUP BY "sessionId"
      ORDER BY MAX("occurredAt") DESC
      OFFSET ${offset}
      LIMIT ${limit}
    `;

    const sessionIds = aggregates.map((a) => a.sessionId);
    const sessionRows = sessionIds.length
      ? await this.prisma.session.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, userId: true, createdAt: true, country: true, region: true, city: true, gclid: true, userAgent: true },
        })
      : [];
    const sessionById = new Map(sessionRows.map((s) => [s.id, s]));

    const userIds = Array.from(
      new Set(sessionRows.map((s) => s.userId).filter((v): v is string => !!v)),
    );
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true },
        })
      : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    const sessions = aggregates.map((a) => {
      const s = sessionById.get(a.sessionId);
      const duration = Math.max(0, Math.round((a.last.getTime() - a.first.getTime()) / 1000));
      return {
        sessionId: a.sessionId,
        lastEvent: a.last.toISOString(),
        duration,
        eventCount: Number(a.count),
        userId: s?.userId ?? null,
        email: s?.userId ? emailById.get(s.userId) ?? null : null,
        country: s?.country ?? null,
        region: s?.region ?? null,
        city: s?.city ?? null,
        device: detectDevice(s?.userAgent ?? null),
        source: s?.gclid ? "Ads" : "Direct",
      };
    });

    return { sessions, total: totalCount, hasMore: offset + sessions.length < totalCount };
  }

  @Get("analytics/sessions")
  async sessions(
    @Query("sessionId") sessionId?: string,
    @Query("event") event?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("eventOffset") eventOffsetRaw = "0",
    @Query("eventLimit") eventLimitRaw = "200",
  ) {
    if (sessionId) {
      const eventOffset = Math.max(0, parseInt(eventOffsetRaw, 10) || 0);
      const eventLimit = Math.min(1000, Math.max(1, parseInt(eventLimitRaw, 10) || 200));
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          events: {
            orderBy: { occurredAt: "desc" },
            skip: eventOffset,
            take: eventLimit,
            select: { id: true, event: true, occurredAt: true, createdAt: true },
          },
          _count: { select: { events: true } },
        },
      });
      let restaurantName: string | null = null;
      let email: string | null = null;
      if (session?.companyId) {
        const r = await this.prisma.restaurant.findFirst({
          where: { companyId: session.companyId },
          select: { title: true },
        });
        restaurantName = r?.title ?? null;
      }
      if (session?.userId) {
        const u = await this.prisma.user.findUnique({
          where: { id: session.userId },
          select: { email: true },
        });
        email = u?.email ?? null;
      }
      return {
        session: session
          ? {
              id: session.id,
              userId: session.userId,
              email,
              companyId: session.companyId,
              restaurantName,
              ip: session.ip,
              userAgent: session.userAgent,
              device: detectDevice(session.userAgent),
              country: session.country,
              region: session.region,
              city: session.city,
              gclid: session.gclid,
              createdAt: session.createdAt,
            }
          : null,
        events: session?.events ?? [],
        eventsTotal: session?._count?.events ?? 0,
        hasMore: session
          ? eventOffset + session.events.length < (session._count?.events ?? 0)
          : false,
      };
    }

    const dateFrom = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dateTo = to ? new Date(to) : new Date();
    const where: Record<string, unknown> = {
      events: { some: { occurredAt: { gte: dateFrom, lte: dateTo } } },
    };

    if (event) {
      const matching = await this.prisma.analyticsEvent.findMany({
        where: { event, occurredAt: { gte: dateFrom, lte: dateTo } },
        distinct: ["sessionId"],
        select: { sessionId: true },
        take: 200,
      });
      const ids = matching.map((m) => m.sessionId);
      if (ids.length === 0) return { sessions: [] };
      where.id = { in: ids };
    }

    const sessions = await this.prisma.session.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        userId: true,
        createdAt: true,
        _count: { select: { events: true } },
      },
    });

    return {
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        userId: s.userId,
        createdAt: s.createdAt,
        eventCount: s._count.events,
      })),
    };
  }

  @Delete("analytics/sessions")
  @HttpCode(HttpStatus.OK)
  async deleteSession(@Body() body: { sessionId?: string }) {
    if (!body.sessionId) throw new BadRequestException("sessionId required");
    await this.prisma.session.delete({ where: { id: body.sessionId } });
    return { success: true };
  }
}
// ────────────────── helpers ──────────────────

/** Coarse device classification from a User-Agent string. Order matters — tablet check
 *  precedes mobile because iPad UAs may match both signatures. Returns "unknown" when the
 *  UA is missing or unrecognized. */
type Device = "mobile" | "tablet" | "desktop" | "unknown";
function detectDevice(ua: string | null | undefined): Device {
  if (!ua) return "unknown";
  // iPad on iPadOS 13+ identifies as "Macintosh" — also catch via touch-points hint when present.
  if (/ipad|tablet|playbook|silk|kindle|nexus 7|nexus 9|nexus 10/i.test(ua)) return "tablet";
  if (/mobile|android|iphone|ipod|blackberry|windows phone|opera mini|iemobile/i.test(ua)) return "mobile";
  return "desktop";
}

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
  if (period === "all") {
    return { dateFrom: new Date(0) };
  }
  if (period === "7days") {
    return { dateFrom: new Date(todayStart.getTime() - 7 * 86400000) };
  }
  return { dateFrom: todayStart };
}
