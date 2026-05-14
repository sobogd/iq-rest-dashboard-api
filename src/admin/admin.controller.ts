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
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { OAuth2Client } from "google-auth-library";
import type { Request, Response } from "express";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
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
    const [monthly, today, d45, d60, d85, lastVisits] = ids.length
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
        ])
      : [[], [], [], [], [], []];
    const monthlyMap = new Map(monthly.map((r) => [r.companyId, Number(r.count)]));
    const todayMap = new Map(today.map((r) => [r.companyId, Number(r.count)]));
    const d45Map = new Map(d45.map((r) => [r.companyId, Number(r.count)]));
    const d60Map = new Map(d60.map((r) => [r.companyId, Number(r.count)]));
    const d85Map = new Map(d85.map((r) => [r.companyId, Number(r.count)]));
    const lastVisitMap = new Map(lastVisits.map((r) => [r.companyId, r.last]));

    const items = companies.map((c) => ({
      id: c.id,
      name: c.restaurants[0]?.title || null,
      plan: c.plan,
      subscriptionStatus: c.subscriptionStatus,
      trialEndsAt: c.trialEndsAt?.toISOString() ?? null,
      categoriesCount: c._count.categories,
      itemsCount: c._count.items,
      messagesCount: c._count.supportMessages,
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

    // Saved gclid drives conversion upload UI. Last usage event gclid suggested as fallback.
    const lastGclidEvent = await this.prisma.usageEvent.findFirst({
      where: { companyId: id, gclid: { not: null } },
      orderBy: { at: "desc" },
      select: { gclid: true },
    });

    return {
      id: company.id,
      name: company.name,
      createdAt: company.createdAt,
      googleClickId: company.googleClickId,
      suggestedGclid: lastGclidEvent?.gclid ?? null,
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
    @Body() body: { template?: string },
  ) {
    const template = body.template;
    if (template !== "welcome_personal" && template !== "menu_almost_ready") {
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
    const locale = owner.preferredLocale || restaurant?.defaultLanguage || "en";
    const name = restaurant?.title || owner.email.split("@")[0];

    if (template === "welcome_personal") {
      await this.mail.sendWelcomePersonal({ email: owner.email, name, locale });
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
  ) {
    const where: Prisma.UsageEventWhereInput = {};
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

    const PAGE_SIZE = 20;
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
        is_bot: true,
        referrer_source: true,
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
        isBot: r.is_bot,
        referrerSource: r.referrer_source,
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
        is_bot: true, referrer_source: true,
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
        isBot: r.is_bot,
        referrerSource: r.referrer_source,
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

  // ────────────────── CONVERSION UPLOAD ──────────────────

  /** Set/update gclid linked to a company. */
  @Post("companies/:id/gclid")
  @HttpCode(HttpStatus.OK)
  async setCompanyGclid(@Param("id") id: string, @Body() body: { gclid?: string }) {
    const gclid = (body?.gclid ?? "").trim();
    if (!gclid) throw new BadRequestException("gclid required");
    const company = await this.prisma.company.findUnique({ where: { id }, select: { id: true } });
    if (!company) throw new NotFoundException("Company not found");
    await this.prisma.company.update({ where: { id }, data: { googleClickId: gclid } });
    return { ok: true, googleClickId: gclid };
  }

  /** Send a conversion (T2 registration or T3 purchase) using company's saved gclid. */
  @Post("companies/:id/send-conversion")
  @HttpCode(HttpStatus.OK)
  async sendCompanyConversion(@Param("id") id: string, @Body() body: { type?: string }) {
    const type = (body?.type ?? "").trim().toUpperCase();
    const CONVERSIONS: Record<string, { id: string }> = {
      T2: { id: "7499129024" }, // registration
      T3: { id: "7596477518" }, // purchase
    };
    const conv = CONVERSIONS[type];
    if (!conv) throw new BadRequestException("type must be T2 or T3");

    const company = await this.prisma.company.findUnique({
      where: { id },
      select: { id: true, googleClickId: true },
    });
    if (!company) throw new NotFoundException("Company not found");
    const gclid = company.googleClickId;
    if (!gclid) throw new BadRequestException("Company has no linked gclid");

    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID")!;
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET")!;
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN")!;
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN")!;
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }

    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();

    const now = new Date();
    const local = new Date(now.getTime() + 2 * 60 * 60000);
    const dt = local.toISOString().replace("T", " ").slice(0, 19) + "+02:00";

    const res = await fetch(
      "https://googleads.googleapis.com/v23/customers/6803239831:uploadClickConversions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          "login-customer-id": "3424878580",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversions: [{
            gclid,
            conversionAction: `customers/6803239831/conversionActions/${conv.id}`,
            conversionDateTime: dt,
          }],
          partialFailure: true,
        }),
      },
    );

    const json = (await parseGadsResponse(res)) as {
      partialFailureError?: { code?: number; message?: string; details?: unknown[] };
      results?: { gclid?: string; conversionAction?: string; conversionDateTime?: string }[];
    };
    if (!res.ok) throw new BadRequestException(JSON.stringify(json));
    if (json.partialFailureError && json.partialFailureError.message) {
      throw new BadRequestException({
        message: "Conversion not accepted by Google Ads",
        partialFailureError: json.partialFailureError,
        results: json.results,
      });
    }
    if (!json.results || json.results.length === 0) {
      throw new BadRequestException({
        message: "Google Ads returned no accepted conversion",
        results: json.results,
      });
    }
    return { ok: true, type, result: json };
  }

  // ────────────────── GOOGLE ADS ──────────────────

  /** Berlin-date-anchored BETWEEN clause for GAQL.
   *  today | yesterday | last7days | last30days — all include today (except yesterday). */
  private dateRangeSql(range?: string): string {
    const RANGES: Record<string, { startDaysAgo: number; endDaysAgo: number }> = {
      today: { startDaysAgo: 0, endDaysAgo: 0 },
      yesterday: { startDaysAgo: 1, endDaysAgo: 1 },
      last7days: { startDaysAgo: 6, endDaysAgo: 0 },
      last30days: { startDaysAgo: 29, endDaysAgo: 0 },
    };
    const r = RANGES[range ?? "today"] ?? RANGES.today;
    // Berlin = UTC+2 in May 2026 (CEST). Shift now to Berlin to get correct calendar date.
    const berlinNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const fmt = (offsetDays: number) => {
      const d = new Date(berlinNow.getTime() - offsetDays * 24 * 60 * 60 * 1000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };
    return `BETWEEN '${fmt(r.startDaysAgo)}' AND '${fmt(r.endDaysAgo)}'`;
  }

  private async gadsClient() {
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    const CUST = "6803239831";
    const search = async (query: string): Promise<any[]> => {
      const res = await fetch(
        `https://googleads.googleapis.com/v23/customers/${CUST}/googleAds:search`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "developer-token": developerToken,
            ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        },
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new BadRequestException(`Google Ads search failed: ${txt.slice(0, 500)}`);
      }
      const j = (await res.json()) as { results?: any[] };
      return j.results ?? [];
    };
    return { search };
  }

  /** Page 1 — list of campaigns. Returns campaigns w/ metrics + aggregated timeline. */
  @Get("google-ads/page-campaigns")
  async pageCampaigns(
    @Query("status") filterStatus?: string,
    @Query("dateRange") filterDateRange?: string,
  ) {
    const dateSql = this.dateRangeSql(filterDateRange);
    const { search } = await this.gadsClient();
    const STATUS_MAP: Record<string, "ENABLED" | "PAUSED"> = { ENABLED: "ENABLED", PAUSED: "PAUSED" };

    // Campaigns with metrics
    const campRows = await search(`
      SELECT campaign.id, campaign.name, campaign.status,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date ${dateSql}
    `);
    const campaigns: Array<any> = [];
    const seen = new Set<string>();
    for (const r of campRows) {
      const id = String(r.campaign.id);
      const st = STATUS_MAP[r.campaign.status];
      if (!st) continue;
      const m = r.metrics ?? {};
      campaigns.push({
        id, name: String(r.campaign.name), status: st,
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        cost: Number(m.costMicros ?? 0) / 1e6,
      });
      seen.add(id);
    }
    // Campaigns with 0 impressions in period
    const allRows = await search(`SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.status != 'REMOVED'`);
    for (const r of allRows) {
      const id = String(r.campaign.id);
      if (seen.has(id)) continue;
      const st = STATUS_MAP[r.campaign.status];
      if (!st) continue;
      campaigns.push({ id, name: String(r.campaign.name), status: st, impressions: 0, clicks: 0, conversions: 0, cost: 0 });
    }

    // Timeline (aggregated across all campaigns) — always grouped by hour-of-day,
    // summed across the selected date range. 24 buckets, "00:00".."23:00".
    const tlRows = await search(`
      SELECT segments.hour, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign WHERE segments.date ${dateSql} AND metrics.impressions > 0
    `);
    const tlMap = new Map<string, any>();
    for (const r of tlRows) {
      const hour = r.segments?.hour;
      if (hour == null) continue;
      const time = `${String(hour).padStart(2, "0")}:00`;
      const b = tlMap.get(time) ?? { time, impressions: 0, clicks: 0, conversions: 0, cost: 0 };
      b.impressions += Number(r.metrics?.impressions ?? 0);
      b.clicks += Number(r.metrics?.clicks ?? 0);
      b.conversions += Number(r.metrics?.conversions ?? 0);
      b.cost += Number(r.metrics?.costMicros ?? 0) / 1e6;
      tlMap.set(time, b);
    }
    const timeline = Array.from(tlMap.values()).sort((a, b) => (a.time > b.time ? -1 : 1));

    return { campaigns, timeline };
  }

  /** Page 2 — campaign detail: ad groups list + negatives count. */
  @Get("google-ads/page-campaign/:id")
  async pageCampaign(
    @Param("id") campaignId: string,
    @Query("status") filterStatus?: string,
    @Query("dateRange") filterDateRange?: string,
  ) {
    const dateSql = this.dateRangeSql(filterDateRange);
    const { search } = await this.gadsClient();
    const STATUS_MAP: Record<string, "ENABLED" | "PAUSED"> = { ENABLED: "ENABLED", PAUSED: "PAUSED" };

    const [campMeta] = await search(`SELECT campaign.id, campaign.name FROM campaign WHERE campaign.id = ${campaignId}`);
    if (!campMeta) throw new NotFoundException("Campaign not found");
    const campaign = { id: String(campMeta.campaign.id), name: String(campMeta.campaign.name) };

    const agRows = await search(`
      SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.final_url_suffix,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.id = ${campaignId}
        AND segments.date ${dateSql}
    `);
    const seen = new Set<string>();
    const adGroups: any[] = [];
    for (const r of agRows) {
      const st = STATUS_MAP[r.adGroup.status];
      if (!st) continue;
      const m = r.metrics ?? {};
      adGroups.push({
        id: String(r.adGroup.id), name: String(r.adGroup.name), status: st,
        suffix: r.adGroup.finalUrlSuffix || undefined,
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        cost: Number(m.costMicros ?? 0) / 1e6,
      });
      seen.add(String(r.adGroup.id));
    }
    // Zero-imp ad groups
    const allAgRows = await search(`SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.final_url_suffix FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.id = ${campaignId}`);
    for (const r of allAgRows) {
      const id = String(r.adGroup.id);
      if (seen.has(id)) continue;
      const st = STATUS_MAP[r.adGroup.status];
      if (!st) continue;
      adGroups.push({
        id, name: String(r.adGroup.name), status: st,
        suffix: r.adGroup.finalUrlSuffix || undefined,
        impressions: 0, clicks: 0, conversions: 0, cost: 0,
      });
    }

    // Negatives count
    const negCamp = await search(`
      SELECT campaign_criterion.criterion_id FROM campaign_criterion
      WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE
        AND campaign_criterion.status != 'REMOVED' AND campaign.id = ${campaignId}
    `);
    const negAg = await search(`
      SELECT ad_group_criterion.criterion_id FROM ad_group_criterion
      WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = TRUE
        AND ad_group_criterion.status != 'REMOVED' AND campaign.id = ${campaignId}
    `);
    return { campaign, adGroups, negativesCount: negCamp.length + negAg.length };
  }

  /** Page 3 — ad group detail: keywords + ads (full details) + campaign assets. */
  @Get("google-ads/page-ad-group/:id")
  async pageAdGroup(
    @Param("id") adGroupId: string,
    @Query("status") filterStatus?: string,
    @Query("dateRange") filterDateRange?: string,
  ) {
    const dateSql = this.dateRangeSql(filterDateRange);
    const { search } = await this.gadsClient();
    const STATUS_MAP: Record<string, "ENABLED" | "PAUSED"> = { ENABLED: "ENABLED", PAUSED: "PAUSED" };
    const MT_LABEL: Record<string, string> = { EXACT: "E", PHRASE: "P", BROAD: "B" };

    const [agMeta] = await search(`
      SELECT ad_group.id, ad_group.name, ad_group.final_url_suffix, campaign.id, campaign.name
      FROM ad_group WHERE ad_group.id = ${adGroupId}
    `);
    if (!agMeta) throw new NotFoundException("Ad group not found");
    const campaignId = String(agMeta.campaign.id);
    const adGroup = {
      id: String(agMeta.adGroup.id),
      name: String(agMeta.adGroup.name),
      suffix: agMeta.adGroup.finalUrlSuffix || undefined,
      campaignId,
      campaignName: String(agMeta.campaign.name),
    };

    // Keywords w/ metrics + QS + bid
    const kwRows = await search(`
      SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
        ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros,
        ad_group_criterion.final_urls, ad_group_criterion.final_url_suffix, ad_group_criterion.quality_info.quality_score,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM keyword_view WHERE ad_group.id = ${adGroupId} AND ad_group_criterion.status != 'REMOVED'
        AND segments.date ${dateSql}
    `);
    const keywords: any[] = [];
    for (const r of kwRows) {
      if (r.adGroupCriterion.negative === true) continue;
      const st = STATUS_MAP[r.adGroupCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.adGroupCriterion.keyword.matchType] ?? "?";
      const m = r.metrics ?? {};
      const bidMicros = r.adGroupCriterion.cpcBidMicros ?? r.adGroupCriterion.effectiveCpcBidMicros;
      const qs = r.adGroupCriterion.qualityInfo?.qualityScore;
      keywords.push({
        id: String(r.adGroupCriterion.criterionId),
        title: `[${mt}] "${r.adGroupCriterion.keyword.text}"`,
        status: st,
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        cost: Number(m.costMicros ?? 0) / 1e6,
        qualityScore: typeof qs === "number" ? qs : undefined,
        bid: bidMicros ? Number(bidMicros) / 1e6 : undefined,
      });
    }

    // Ads w/ full details
    const adRows = await search(`
      SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls,
        ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2,
        ad_group_ad.ad_strength, ad_group_ad.status
      FROM ad_group_ad WHERE ad_group.id = ${adGroupId} AND ad_group_ad.status != 'REMOVED'
    `);
    const ads: any[] = [];
    for (const r of adRows) {
      const st = STATUS_MAP[r.adGroupAd.status];
      if (!st) continue;
      const rsa = r.adGroupAd?.ad?.responsiveSearchAd ?? {};
      const heads: any[] = rsa.headlines ?? [];
      const descs: any[] = rsa.descriptions ?? [];
      ads.push({
        id: String(r.adGroupAd.ad.id),
        status: st,
        finalUrls: r.adGroupAd?.ad?.finalUrls ?? [],
        headlines: heads.map((h: any) => ({ text: h.text ?? "", pinned: h.pinnedField })),
        descriptions: descs.map((d: any) => ({ text: d.text ?? "", pinned: d.pinnedField })),
        path1: rsa.path1 || undefined,
        path2: rsa.path2 || undefined,
        adStrength: r.adGroupAd?.adStrength,
      });
    }

    // Campaign-level assets
    const assetRows = await search(`
      SELECT campaign.id, asset.id, asset.type, asset.name,
        asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2,
        campaign_asset.field_type, campaign_asset.status
      FROM campaign_asset WHERE campaign.id = ${campaignId} AND campaign_asset.status = 'ENABLED'
    `);
    const assets = {
      businessNames: [] as string[],
      sitelinks: [] as Array<{ title: string; desc1?: string; desc2?: string }>,
      imageCount: 0,
      logoCount: 0,
    };
    for (const r of assetRows) {
      const ft = r.campaignAsset?.fieldType;
      if (ft === "SITELINK" && r.asset?.sitelinkAsset?.linkText) {
        assets.sitelinks.push({
          title: r.asset.sitelinkAsset.linkText,
          desc1: r.asset.sitelinkAsset.description1,
          desc2: r.asset.sitelinkAsset.description2,
        });
      } else if (ft === "BUSINESS_NAME" && r.asset?.name) {
        assets.businessNames.push(r.asset.name);
      } else if (ft === "BUSINESS_LOGO" || ft === "LOGO") {
        assets.logoCount += 1;
      } else if (ft === "MARKETING_IMAGE" || ft === "SQUARE_MARKETING_IMAGE" || ft === "PORTRAIT_MARKETING_IMAGE") {
        assets.imageCount += 1;
      }
    }

    return { adGroup, keywords, ads, assets };
  }

  /** Page 4 — negatives for campaign (campaign-level + ad-group-level merged). */
  @Get("google-ads/page-negatives/:campaignId")
  async pageNegatives(
    @Param("campaignId") campaignId: string,
    @Query("status") filterStatus?: string,
  ) {
    const { search } = await this.gadsClient();
    const STATUS_MAP: Record<string, "ENABLED" | "PAUSED"> = { ENABLED: "ENABLED", PAUSED: "PAUSED" };
    const MT_LABEL: Record<string, string> = { EXACT: "E", PHRASE: "P", BROAD: "B" };

    const negCamp = await search(`
      SELECT campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.status
      FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE
        AND campaign_criterion.status != 'REMOVED' AND campaign.id = ${campaignId}
    `);
    const negAg = await search(`
      SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group.name
      FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = TRUE
        AND ad_group_criterion.status != 'REMOVED' AND campaign.id = ${campaignId}
    `);
    const negatives: any[] = [];
    for (const r of negCamp) {
      const st = STATUS_MAP[r.campaignCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.campaignCriterion.keyword.matchType] ?? "?";
      negatives.push({
        id: `c-${r.campaignCriterion.criterionId}`,
        title: `[${mt}] "${r.campaignCriterion.keyword.text}" · campaign-level`,
        status: st,
      });
    }
    for (const r of negAg) {
      const st = STATUS_MAP[r.adGroupCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.adGroupCriterion.keyword.matchType] ?? "?";
      negatives.push({
        id: `ag-${r.adGroupCriterion.criterionId}`,
        title: `[${mt}] "${r.adGroupCriterion.keyword.text}" · ${r.adGroup.name}`,
        status: st,
      });
    }
    return { negatives };
  }

  /** Firehose — everything needed for nav between all views, one shot.
   *  Returns ALL statuses (ENABLED + PAUSED). Frontend filters status client-side. */
  @Get("google-ads/all")
  async googleAdsAll(
    @Query("dateRange") filterDateRange?: string,
  ) {
    const dateSql = this.dateRangeSql(filterDateRange);
    const { search } = await this.gadsClient();
    const STATUS_MAP: Record<string, "ENABLED" | "PAUSED"> = { ENABLED: "ENABLED", PAUSED: "PAUSED" };
    const MT_LABEL: Record<string, string> = { EXACT: "E", PHRASE: "P", BROAD: "B" };

    const T2_ACTION = "customers/6803239831/conversionActions/7499129024";
    const T3_ACTION = "customers/6803239831/conversionActions/7596477518";
    const CONV_FILTER = `segments.conversion_action IN ('${T2_ACTION}','${T3_ACTION}')`;

    const [campRows, allCampRows, agRows, allAgRows, adRows, kwRows, negCampRows, negAgRows, tlRows, assetRows, agAssetRows, stRows, targetingRows, campConvRows, agConvRows, kwConvRows, stConvRows, tlConvRows] = await Promise.all([
      search(`SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.explicitly_shared, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date ${dateSql}`),
      search(`SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED'`),
      search(`SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.final_url_suffix, ad_group.cpc_bid_micros, campaign.id, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' AND segments.date ${dateSql}`),
      search(`SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.final_url_suffix, ad_group.cpc_bid_micros, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`),
      search(`SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.ad_strength, ad_group_ad.status, ad_group.id, campaign.id FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED'`),
      search(`SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.final_urls, ad_group_criterion.quality_info.quality_score, ad_group.id, campaign.id, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED' AND segments.date ${dateSql}`),
      search(`SELECT campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.status, campaign.id FROM campaign_criterion WHERE campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED'`),
      search(`SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group.id, ad_group.name, campaign.id FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = TRUE AND ad_group_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED'`),
      search(`SELECT segments.hour, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date ${dateSql} AND metrics.impressions > 0`),
      search(`SELECT campaign.id, asset.id, asset.type, asset.name, asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, campaign_asset.field_type, campaign_asset.status FROM campaign_asset WHERE campaign_asset.status = 'ENABLED'`),
      search(`SELECT ad_group.id, asset.id, asset.type, asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, asset.callout_asset.callout_text, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values, asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels, asset.final_urls, ad_group_asset.field_type, ad_group_asset.status FROM ad_group_asset WHERE ad_group_asset.status = 'ENABLED' AND ad_group_asset.field_type IN ('SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO')`),
      search(`SELECT ad_group.id, search_term_view.search_term, search_term_view.status, segments.keyword.info.text, segments.keyword.info.match_type, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros FROM search_term_view WHERE segments.date ${dateSql}`),
      search(`SELECT campaign.id, campaign_criterion.type, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, campaign_criterion.negative FROM campaign_criterion WHERE campaign.status != 'REMOVED' AND campaign_criterion.status != 'REMOVED'`),
      search(`SELECT campaign.id, segments.conversion_action, metrics.conversions FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date ${dateSql} AND ${CONV_FILTER}`),
      search(`SELECT ad_group.id, segments.conversion_action, metrics.conversions FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' AND segments.date ${dateSql} AND ${CONV_FILTER}`),
      search(`SELECT ad_group_criterion.criterion_id, ad_group.id, segments.conversion_action, metrics.conversions FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED' AND segments.date ${dateSql} AND ${CONV_FILTER}`),
      search(`SELECT ad_group.id, search_term_view.search_term, segments.keyword.info.text, segments.keyword.info.match_type, segments.conversion_action, metrics.conversions FROM search_term_view WHERE segments.date ${dateSql} AND ${CONV_FILTER}`),
      search(`SELECT segments.hour, segments.conversion_action, metrics.conversions FROM campaign WHERE segments.date ${dateSql} AND ${CONV_FILTER}`),
    ]);

    // Build per-entity T2/T3 conversion breakdowns
    const convByCampaign = new Map<string, { t2: number; t3: number }>();
    for (const r of campConvRows) {
      const cId = String(r.campaign?.id ?? "");
      if (!cId) continue;
      const action = r.segments?.conversionAction;
      const v = Number(r.metrics?.conversions ?? 0);
      const cur = convByCampaign.get(cId) ?? { t2: 0, t3: 0 };
      if (action === T2_ACTION) cur.t2 += v;
      else if (action === T3_ACTION) cur.t3 += v;
      convByCampaign.set(cId, cur);
    }
    const convByAdGroup = new Map<string, { t2: number; t3: number }>();
    for (const r of agConvRows) {
      const agId = String(r.adGroup?.id ?? "");
      if (!agId) continue;
      const action = r.segments?.conversionAction;
      const v = Number(r.metrics?.conversions ?? 0);
      const cur = convByAdGroup.get(agId) ?? { t2: 0, t3: 0 };
      if (action === T2_ACTION) cur.t2 += v;
      else if (action === T3_ACTION) cur.t3 += v;
      convByAdGroup.set(agId, cur);
    }
    const convByKeyword = new Map<string, { t2: number; t3: number }>();
    for (const r of kwConvRows) {
      const cId = String(r.adGroupCriterion?.criterionId ?? "");
      if (!cId) continue;
      const action = r.segments?.conversionAction;
      const v = Number(r.metrics?.conversions ?? 0);
      const cur = convByKeyword.get(cId) ?? { t2: 0, t3: 0 };
      if (action === T2_ACTION) cur.t2 += v;
      else if (action === T3_ACTION) cur.t3 += v;
      convByKeyword.set(cId, cur);
    }
    const convBySt = new Map<string, { t2: number; t3: number }>();
    for (const r of stConvRows) {
      const agId = String(r.adGroup?.id ?? "");
      if (!agId) continue;
      const key = `${agId}|${r.searchTermView?.searchTerm ?? ""}|${r.segments?.keyword?.info?.text ?? ""}|${r.segments?.keyword?.info?.matchType ?? ""}`;
      const action = r.segments?.conversionAction;
      const v = Number(r.metrics?.conversions ?? 0);
      const cur = convBySt.get(key) ?? { t2: 0, t3: 0 };
      if (action === T2_ACTION) cur.t2 += v;
      else if (action === T3_ACTION) cur.t3 += v;
      convBySt.set(key, cur);
    }

    // Resolve campaign targeting (geo + language) with display names — single round-trip per type
    const campaignTargeting: Record<string, { geos: Array<{ name: string; code: string | null }>; languages: Array<{ name: string; code: string | null }> }> = {};
    {
      const geoSet = new Set<string>();
      const langSet = new Set<string>();
      const byCamp: Record<string, { geoRes: string[]; langRes: string[] }> = {};
      for (const r of targetingRows as any[]) {
        const c = r.campaignCriterion;
        const cId = String(r.campaign?.id ?? "");
        if (!c || !cId || c.negative === true) continue;
        const slot = byCamp[cId] ?? (byCamp[cId] = { geoRes: [], langRes: [] });
        if (c.type === "LOCATION" && c.location?.geoTargetConstant) {
          slot.geoRes.push(c.location.geoTargetConstant);
          geoSet.add(c.location.geoTargetConstant);
        } else if (c.type === "LANGUAGE" && c.language?.languageConstant) {
          slot.langRes.push(c.language.languageConstant);
          langSet.add(c.language.languageConstant);
        }
      }
      const geoMap: Record<string, { name: string; code: string | null }> = {};
      const langMap: Record<string, { name: string; code: string | null }> = {};
      if (geoSet.size) {
        const inList = Array.from(geoSet).map((g) => `'${g}'`).join(",");
        const rows = await search(`SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${inList})`);
        for (const r of rows as any[]) {
          const g = r.geoTargetConstant;
          if (!g?.resourceName) continue;
          geoMap[g.resourceName] = { name: g.name ?? g.resourceName, code: g.countryCode ?? null };
        }
      }
      if (langSet.size) {
        const ids = Array.from(langSet).map((l) => l.split("/")[1]).filter(Boolean).join(",");
        if (ids) {
          const rows = await search(`SELECT language_constant.resource_name, language_constant.name, language_constant.code FROM language_constant WHERE language_constant.id IN (${ids})`);
          for (const r of rows as any[]) {
            const l = r.languageConstant;
            if (!l?.resourceName) continue;
            langMap[l.resourceName] = { name: l.name ?? l.resourceName, code: l.code ?? null };
          }
        }
      }
      for (const [cId, slot] of Object.entries(byCamp)) {
        campaignTargeting[cId] = {
          geos: slot.geoRes.map((g) => geoMap[g]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
          languages: slot.langRes.map((l) => langMap[l]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)),
        };
      }
    }

    const stByAdGroup: Record<string, any[]> = {};
    {
      const MT_LABEL: Record<string, string> = { EXACT: "E", PHRASE: "P", BROAD: "B" };
      const ST_LABEL: Record<string, string> = { ADDED: "added", EXCLUDED: "excluded", NONE: "none", ADDED_EXCLUDED: "added_excluded", UNKNOWN: "unknown" };
      for (const r of stRows as any[]) {
        const agId = String(r.adGroup?.id ?? "");
        if (!agId) continue;
        const term = r.searchTermView?.searchTerm ?? "";
        const kwText = r.segments?.keyword?.info?.text ?? "";
        const kwMt = r.segments?.keyword?.info?.matchType ?? "";
        const key = `${agId}|${term}|${kwText}|${kwMt}`;
        const conv = convBySt.get(key) ?? { t2: 0, t3: 0 };
        const arr = stByAdGroup[agId] ?? [];
        arr.push({
          searchTerm: term,
          status: ST_LABEL[r.searchTermView?.status] ?? r.searchTermView?.status,
          matchedKwText: kwText,
          matchedKwMt: kwMt,
          matchedKeyword: `[${MT_LABEL[kwMt] ?? "?"}] "${kwText}"`,
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          conversions: Number(r.metrics?.conversions ?? 0),
          convT2: conv.t2,
          convT3: conv.t3,
          cost: Number(r.metrics?.costMicros ?? 0) / 1e6,
        });
        stByAdGroup[agId] = arr;
      }
      for (const k of Object.keys(stByAdGroup)) {
        stByAdGroup[k].sort((a, b) => b.impressions - a.impressions);
      }
    }

    // Campaigns
    const seen = new Set<string>();
    const campaigns: any[] = [];
    for (const r of campRows) {
      const id = String(r.campaign.id);
      const st = STATUS_MAP[r.campaign.status];
      if (!st) continue;
      const m = r.metrics ?? {};
      const cb = r.campaignBudget ?? {};
      const conv = convByCampaign.get(id) ?? { t2: 0, t3: 0 };
      campaigns.push({
        id, name: String(r.campaign.name), status: st,
        budget: cb.amountMicros ? Number(cb.amountMicros) / 1e6 : undefined,
        budgetShared: Boolean(cb.explicitlyShared),
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        convT2: conv.t2,
        convT3: conv.t3,
        cost: Number(m.costMicros ?? 0) / 1e6,
      });
      seen.add(id);
    }
    for (const r of allCampRows) {
      const id = String(r.campaign.id);
      if (seen.has(id)) continue;
      const st = STATUS_MAP[r.campaign.status];
      if (!st) continue;
      const cb = r.campaignBudget ?? {};
      campaigns.push({
        id, name: String(r.campaign.name), status: st,
        budget: cb.amountMicros ? Number(cb.amountMicros) / 1e6 : undefined,
        budgetShared: Boolean(cb.explicitlyShared),
        impressions: 0, clicks: 0, conversions: 0, convT2: 0, convT3: 0, cost: 0,
      });
    }

    // Ad groups
    const agSeen = new Set<string>();
    const adGroups: any[] = [];
    for (const r of agRows) {
      const st = STATUS_MAP[r.adGroup.status];
      if (!st) continue;
      const m = r.metrics ?? {};
      const agId = String(r.adGroup.id);
      const conv = convByAdGroup.get(agId) ?? { t2: 0, t3: 0 };
      adGroups.push({
        id: agId, name: String(r.adGroup.name), status: st,
        campaignId: String(r.campaign.id),
        suffix: r.adGroup.finalUrlSuffix || undefined,
        defaultBid: r.adGroup.cpcBidMicros ? Number(r.adGroup.cpcBidMicros) / 1e6 : undefined,
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        convT2: conv.t2,
        convT3: conv.t3,
        cost: Number(m.costMicros ?? 0) / 1e6,
      });
      agSeen.add(agId);
    }
    for (const r of allAgRows) {
      const id = String(r.adGroup.id);
      if (agSeen.has(id)) continue;
      const st = STATUS_MAP[r.adGroup.status];
      if (!st) continue;
      adGroups.push({
        id, name: String(r.adGroup.name), status: st,
        campaignId: String(r.campaign.id),
        suffix: r.adGroup.finalUrlSuffix || undefined,
        defaultBid: r.adGroup.cpcBidMicros ? Number(r.adGroup.cpcBidMicros) / 1e6 : undefined,
        impressions: 0, clicks: 0, conversions: 0, convT2: 0, convT3: 0, cost: 0,
      });
    }

    // Ads
    const ads: any[] = [];
    for (const r of adRows) {
      const st = STATUS_MAP[r.adGroupAd.status];
      if (!st) continue;
      const rsa = r.adGroupAd?.ad?.responsiveSearchAd ?? {};
      ads.push({
        id: String(r.adGroupAd.ad.id),
        status: st,
        adGroupId: String(r.adGroup.id),
        campaignId: String(r.campaign.id),
        finalUrls: r.adGroupAd?.ad?.finalUrls ?? [],
        headlines: (rsa.headlines ?? []).map((h: any) => ({ text: h.text ?? "", pinned: h.pinnedField })),
        descriptions: (rsa.descriptions ?? []).map((d: any) => ({ text: d.text ?? "", pinned: d.pinnedField })),
        path1: rsa.path1 || undefined,
        path2: rsa.path2 || undefined,
        adStrength: r.adGroupAd?.adStrength,
      });
    }

    // Keywords (filter out negatives just in case)
    const keywords: any[] = [];
    for (const r of kwRows) {
      if (r.adGroupCriterion.negative === true) continue;
      const st = STATUS_MAP[r.adGroupCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.adGroupCriterion.keyword.matchType] ?? "?";
      const m = r.metrics ?? {};
      const bidMicros = r.adGroupCriterion.cpcBidMicros ?? r.adGroupCriterion.effectiveCpcBidMicros;
      const qs = r.adGroupCriterion.qualityInfo?.qualityScore;
      const kwId = String(r.adGroupCriterion.criterionId);
      const conv = convByKeyword.get(kwId) ?? { t2: 0, t3: 0 };
      keywords.push({
        id: kwId,
        title: `[${mt}] "${r.adGroupCriterion.keyword.text}"`,
        text: r.adGroupCriterion.keyword.text,
        matchType: r.adGroupCriterion.keyword.matchType,
        status: st,
        adGroupId: String(r.adGroup.id),
        campaignId: String(r.campaign.id),
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        convT2: conv.t2,
        convT3: conv.t3,
        cost: Number(m.costMicros ?? 0) / 1e6,
        qualityScore: typeof qs === "number" ? qs : undefined,
        bid: bidMicros ? Number(bidMicros) / 1e6 : undefined,
      });
    }

    // Negatives
    const negatives: any[] = [];
    for (const r of negCampRows) {
      const st = STATUS_MAP[r.campaignCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.campaignCriterion.keyword.matchType] ?? "?";
      negatives.push({
        id: `c-${r.campaignCriterion.criterionId}`,
        text: r.campaignCriterion.keyword.text,
        matchType: mt,
        status: st,
        campaignId: String(r.campaign.id),
        scope: "campaign",
        rawId: String(r.campaignCriterion.criterionId),
      });
    }
    for (const r of negAgRows) {
      const st = STATUS_MAP[r.adGroupCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.adGroupCriterion.keyword.matchType] ?? "?";
      negatives.push({
        id: `ag-${r.adGroupCriterion.criterionId}`,
        text: r.adGroupCriterion.keyword.text,
        matchType: mt,
        status: st,
        campaignId: String(r.campaign.id),
        adGroupId: String(r.adGroup.id),
        scope: "ad_group",
        rawId: String(r.adGroupCriterion.criterionId),
      });
    }

    // Timeline — hour-of-day aggregation summed across date range.
    const tlMap = new Map<string, any>();
    for (const r of tlRows) {
      const hour = r.segments?.hour;
      if (hour == null) continue;
      const time = `${String(hour).padStart(2, "0")}:00`;
      const b = tlMap.get(time) ?? { time, impressions: 0, clicks: 0, conversions: 0, convT2: 0, convT3: 0, cost: 0 };
      b.impressions += Number(r.metrics?.impressions ?? 0);
      b.clicks += Number(r.metrics?.clicks ?? 0);
      b.conversions += Number(r.metrics?.conversions ?? 0);
      b.cost += Number(r.metrics?.costMicros ?? 0) / 1e6;
      tlMap.set(time, b);
    }
    for (const r of tlConvRows) {
      const hour = r.segments?.hour;
      if (hour == null) continue;
      const time = `${String(hour).padStart(2, "0")}:00`;
      const action = r.segments?.conversionAction;
      const v = Number(r.metrics?.conversions ?? 0);
      const b = tlMap.get(time) ?? { time, impressions: 0, clicks: 0, conversions: 0, convT2: 0, convT3: 0, cost: 0 };
      if (action === T2_ACTION) b.convT2 += v;
      else if (action === T3_ACTION) b.convT3 += v;
      tlMap.set(time, b);
    }
    const timeline = Array.from(tlMap.values()).sort((a, b) => (a.time > b.time ? -1 : 1));

    // Assets grouped by campaign
    const campaignAssets: Record<string, any> = {};
    for (const r of assetRows) {
      const cId = String(r.campaign.id);
      const a = campaignAssets[cId] ?? { businessNames: [], sitelinks: [], imageCount: 0, logoCount: 0 };
      const ft = r.campaignAsset?.fieldType;
      if (ft === "SITELINK" && r.asset?.sitelinkAsset?.linkText) {
        a.sitelinks.push({
          title: r.asset.sitelinkAsset.linkText,
          desc1: r.asset.sitelinkAsset.description1,
          desc2: r.asset.sitelinkAsset.description2,
        });
      } else if (ft === "BUSINESS_NAME" && r.asset?.name) {
        a.businessNames.push(r.asset.name);
      } else if (ft === "BUSINESS_LOGO" || ft === "LOGO") {
        a.logoCount += 1;
      } else if (ft === "MARKETING_IMAGE" || ft === "SQUARE_MARKETING_IMAGE" || ft === "PORTRAIT_MARKETING_IMAGE") {
        a.imageCount += 1;
      }
      campaignAssets[cId] = a;
    }

    // Ad-group-level assets — keyed by adGroupId, split by field type.
    const adGroupSitelinks: Record<string, Array<{ assetId: string; text: string; desc1?: string; desc2?: string; url: string }>> = {};
    const adGroupCallouts: Record<string, Array<{ assetId: string; text: string }>> = {};
    const adGroupSnippets: Record<string, Array<{ assetId: string; header: string; values: string[] }>> = {};
    const adGroupImages: Record<string, Array<{ assetId: string; fieldType: string; url?: string; width?: number; height?: number }>> = {};
    const IMAGE_FIELD_TYPES = new Set(["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO"]);
    for (const r of agAssetRows as any[]) {
      const agId = String(r.adGroup?.id ?? "");
      const a = r.asset;
      const aga = r.adGroupAsset;
      if (!agId || !a) continue;
      if (aga?.fieldType === "SITELINK") {
        const arr = adGroupSitelinks[agId] ?? (adGroupSitelinks[agId] = []);
        arr.push({
          assetId: String(a.id),
          text: String(a.sitelinkAsset?.linkText ?? ""),
          desc1: a.sitelinkAsset?.description1 ? String(a.sitelinkAsset.description1) : undefined,
          desc2: a.sitelinkAsset?.description2 ? String(a.sitelinkAsset.description2) : undefined,
          url: String((a.finalUrls ?? [])[0] ?? ""),
        });
      } else if (aga?.fieldType === "CALLOUT") {
        const arr = adGroupCallouts[agId] ?? (adGroupCallouts[agId] = []);
        arr.push({
          assetId: String(a.id),
          text: String(a.calloutAsset?.calloutText ?? ""),
        });
      } else if (aga?.fieldType === "STRUCTURED_SNIPPET") {
        const arr = adGroupSnippets[agId] ?? (adGroupSnippets[agId] = []);
        arr.push({
          assetId: String(a.id),
          header: String(a.structuredSnippetAsset?.header ?? ""),
          values: Array.isArray(a.structuredSnippetAsset?.values) ? (a.structuredSnippetAsset.values as unknown[]).map((v) => String(v)) : [],
        });
      } else if (IMAGE_FIELD_TYPES.has(aga?.fieldType)) {
        const arr = adGroupImages[agId] ?? (adGroupImages[agId] = []);
        arr.push({
          assetId: String(a.id),
          fieldType: String(aga.fieldType),
          url: a.imageAsset?.fullSize?.url ? String(a.imageAsset.fullSize.url) : undefined,
          width: a.imageAsset?.fullSize?.widthPixels ? Number(a.imageAsset.fullSize.widthPixels) : undefined,
          height: a.imageAsset?.fullSize?.heightPixels ? Number(a.imageAsset.fullSize.heightPixels) : undefined,
        });
      }
    }
    return { campaigns, adGroups, ads, keywords, negatives, timeline, campaignAssets, campaignTargeting, searchTermsByAdGroup: stByAdGroup, adGroupSitelinks, adGroupCallouts, adGroupSnippets, adGroupImages };
  }

  /** Detail endpoints — pull max fields for modal display. Always fresh. */
  @Get("google-ads/detail/campaign/:id")
  async detailCampaign(@Param("id") id: string) {
    const { search } = await this.gadsClient();
    const [r] = await search(`
      SELECT
        campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
        campaign.serving_status, campaign.payment_mode,
        campaign.optimization_score, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.bidding_strategy_system_status,
        campaign.manual_cpc.enhanced_cpc_enabled, campaign.target_cpa.target_cpa_micros,
        campaign.final_url_suffix, campaign.tracking_url_template,
        campaign.network_settings.target_google_search, campaign.network_settings.target_search_network,
        campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network,
        campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type,
        campaign.experiment_type, campaign.resource_name, campaign.optimization_goal_setting.optimization_goal_types,
        campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.delivery_method, campaign_budget.explicitly_shared, campaign_budget.period
      FROM campaign WHERE campaign.id = ${id}
    `);
    if (!r) throw new NotFoundException("Campaign not found");
    return { record: r };
  }

  @Get("google-ads/detail/ad-group/:id")
  async detailAdGroup(@Param("id") id: string) {
    const { search } = await this.gadsClient();
    const [r] = await search(`
      SELECT
        ad_group.id, ad_group.name, ad_group.status, ad_group.type,
        ad_group.cpc_bid_micros, ad_group.cpm_bid_micros, ad_group.target_cpa_micros,
        ad_group.target_roas, ad_group.percent_cpc_bid_micros, ad_group.target_cpm_micros,
        ad_group.effective_target_cpa_micros, ad_group.effective_target_cpa_source,
        ad_group.final_url_suffix, ad_group.tracking_url_template,
        ad_group.optimized_targeting_enabled, ad_group.resource_name,
        ad_group.targeting_setting.target_restrictions,
        ad_group.ad_rotation_mode,
        ad_group.display_custom_bid_dimension,
        campaign.id, campaign.name
      FROM ad_group WHERE ad_group.id = ${id}
    `);
    if (!r) throw new NotFoundException("Ad group not found");
    return { record: r };
  }

  @Get("google-ads/detail/ad/:adGroupId/:adId")
  async detailAd(@Param("adGroupId") adGroupId: string, @Param("adId") adId: string) {
    const { search } = await this.gadsClient();
    const [r] = await search(`
      SELECT
        ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls,
        ad_group_ad.ad.display_url, ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.url_custom_parameters,
        ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2,
        ad_group_ad.ad_strength, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status,
        ad_group_ad.ad.system_managed_resource_source, ad_group_ad.ad.added_by_google_ads,
        ad_group.id, ad_group.name, campaign.id, campaign.name
      FROM ad_group_ad WHERE ad_group.id = ${adGroupId} AND ad_group_ad.ad.id = ${adId}
    `);
    if (!r) throw new NotFoundException("Ad not found");
    return { record: r };
  }

  @Get("google-ads/detail/keyword/:adGroupId/:critId")
  async detailKeyword(@Param("adGroupId") adGroupId: string, @Param("critId") critId: string) {
    const { search } = await this.gadsClient();
    const [r] = await search(`
      SELECT
        ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
        ad_group_criterion.status, ad_group_criterion.approval_status, ad_group_criterion.system_serving_status,
        ad_group_criterion.cpc_bid_micros, ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.effective_cpc_bid_source,
        ad_group_criterion.cpm_bid_micros,
        ad_group_criterion.final_urls, ad_group_criterion.final_mobile_urls,
        ad_group_criterion.final_url_suffix, ad_group_criterion.tracking_url_template,
        ad_group_criterion.quality_info.quality_score,
        ad_group_criterion.quality_info.creative_quality_score,
        ad_group_criterion.quality_info.post_click_quality_score,
        ad_group_criterion.quality_info.search_predicted_ctr,
        ad_group_criterion.position_estimates.first_page_cpc_micros,
        ad_group_criterion.position_estimates.first_position_cpc_micros,
        ad_group_criterion.position_estimates.top_of_page_cpc_micros,
        ad_group.id, ad_group.name, campaign.id, campaign.name
      FROM ad_group_criterion WHERE ad_group.id = ${adGroupId} AND ad_group_criterion.criterion_id = ${critId}
    `);
    if (!r) throw new NotFoundException("Keyword not found");
    return { record: r };
  }

  @Get("google-ads/detail/negative/:scope/:id")
  async detailNegative(
    @Param("scope") scope: string,
    @Param("id") critId: string,
    @Query("campaignId") campaignId?: string,
    @Query("adGroupId") adGroupId?: string,
  ) {
    const { search } = await this.gadsClient();
    if (scope === "campaign" && campaignId) {
      const [r] = await search(`
        SELECT campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type,
          campaign_criterion.status, campaign_criterion.type, campaign_criterion.negative,
          campaign_criterion.display_name, campaign.id, campaign.name
        FROM campaign_criterion WHERE campaign.id = ${campaignId} AND campaign_criterion.criterion_id = ${critId}
      `);
      if (!r) throw new NotFoundException("Negative not found");
      return { record: r };
    }
    if (scope === "ad_group" && adGroupId) {
      const [r] = await search(`
        SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
          ad_group_criterion.status, ad_group_criterion.type, ad_group_criterion.negative,
          ad_group.id, ad_group.name, campaign.id, campaign.name
        FROM ad_group_criterion WHERE ad_group.id = ${adGroupId} AND ad_group_criterion.criterion_id = ${critId}
      `);
      if (!r) throw new NotFoundException("Negative not found");
      return { record: r };
    }
    throw new BadRequestException("Invalid scope or missing id");
  }

  /** Search terms for a single keyword (date range scoped). */
  @Get("google-ads/search-terms/keyword/:adGroupId/:critId")
  async searchTermsForKeyword(
    @Param("adGroupId") adGroupId: string,
    @Param("critId") critId: string,
    @Query("dateRange") filterDateRange?: string,
  ) {
    const dateSql = this.dateRangeSql(filterDateRange);
    const { search } = await this.gadsClient();
    // search_term_view filtered by ad_group + matched keyword criterion
    const rows = await search(`
      SELECT
        search_term_view.search_term,
        search_term_view.status,
        segments.keyword.info.text,
        segments.keyword.info.match_type,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM search_term_view
      WHERE ad_group.id = ${adGroupId}
        AND segments.date ${dateSql}
    `);
    const MT_LABEL: Record<string, string> = { EXACT: "E", PHRASE: "P", BROAD: "B" };
    const ST_LABEL: Record<string, string> = { ADDED: "added", EXCLUDED: "excluded", NONE: "none", ADDED_EXCLUDED: "added_excluded", UNKNOWN: "unknown" };
    // Filter to rows where matched keyword criterion_id == critId
    // Note: search_term_view doesn't expose criterion_id directly. Filter by matched keyword text (best-effort).
    // Fetch keyword text first.
    const [meta] = await search(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group.id = ${adGroupId} AND ad_group_criterion.criterion_id = ${critId}`);
    const kwText = meta?.adGroupCriterion?.keyword?.text;
    const kwMt = meta?.adGroupCriterion?.keyword?.matchType;
    const items = rows
      .filter((r: any) => {
        const t = r.segments?.keyword?.info?.text;
        const mt = r.segments?.keyword?.info?.matchType;
        return t === kwText && mt === kwMt;
      })
      .map((r: any) => ({
        searchTerm: r.searchTermView?.searchTerm ?? "",
        status: ST_LABEL[r.searchTermView?.status] ?? r.searchTermView?.status,
        matchedKeyword: `[${MT_LABEL[r.segments?.keyword?.info?.matchType] ?? "?"}] "${r.segments?.keyword?.info?.text ?? ""}"`,
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        conversions: Number(r.metrics?.conversions ?? 0),
        cost: Number(r.metrics?.costMicros ?? 0) / 1e6,
      }))
      .sort((a: any, b: any) => b.impressions - a.impressions);
    return { items, keyword: kwText, matchType: MT_LABEL[kwMt] ?? "?" };
  }

  /** Search terms for whole ad group (date range scoped). */
  @Get("google-ads/search-terms/ad-group/:adGroupId")
  async searchTermsForAdGroup(
    @Param("adGroupId") adGroupId: string,
    @Query("dateRange") filterDateRange?: string,
  ) {
    const dateSql = this.dateRangeSql(filterDateRange);
    const { search } = await this.gadsClient();
    const rows = await search(`
      SELECT
        search_term_view.search_term,
        search_term_view.status,
        segments.keyword.info.text,
        segments.keyword.info.match_type,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM search_term_view
      WHERE ad_group.id = ${adGroupId}
        AND segments.date ${dateSql}
    `);
    const MT_LABEL: Record<string, string> = { EXACT: "E", PHRASE: "P", BROAD: "B" };
    const ST_LABEL: Record<string, string> = { ADDED: "added", EXCLUDED: "excluded", NONE: "none", ADDED_EXCLUDED: "added_excluded", UNKNOWN: "unknown" };
    const items = rows
      .map((r: any) => ({
        searchTerm: r.searchTermView?.searchTerm ?? "",
        status: ST_LABEL[r.searchTermView?.status] ?? r.searchTermView?.status,
        matchedKeyword: `[${MT_LABEL[r.segments?.keyword?.info?.matchType] ?? "?"}] "${r.segments?.keyword?.info?.text ?? ""}"`,
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        conversions: Number(r.metrics?.conversions ?? 0),
        cost: Number(r.metrics?.costMicros ?? 0) / 1e6,
      }))
      .sort((a: any, b: any) => b.impressions - a.impressions);
    return { items };
  }

  @Get("google-ads/entities")
  async listGoogleAdsEntities(
    @Query("campaignId") filterCampaignId?: string,
    @Query("status") filterStatus?: string,
    @Query("type") filterType?: string,
    @Query("dateRange") filterDateRange?: string,
  ) {
    const dateSql = this.dateRangeSql(filterDateRange);
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }

    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();

    const CUST = "6803239831";

    const search = async (query: string): Promise<any[]> => {
      const res = await fetch(
        `https://googleads.googleapis.com/v23/customers/${CUST}/googleAds:search`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "developer-token": developerToken,
            ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        },
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new BadRequestException(`Google Ads search failed: ${txt.slice(0, 500)}`);
      }
      const j = (await res.json()) as { results?: any[] };
      return j.results ?? [];
    };

    const STATUS_MAP: Record<string, "ENABLED" | "PAUSED"> = {
      ENABLED: "ENABLED",
      PAUSED: "PAUSED",
    };
    const MT_LABEL: Record<string, string> = {
      EXACT: "E",
      PHRASE: "P",
      BROAD: "B",
    };

    // 1) Campaigns (with date-scoped metrics)
    const campRows = await search(`
      SELECT
        campaign.id, campaign.name, campaign.status,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM campaign
      WHERE campaign.status != 'REMOVED'
        AND segments.date ${dateSql}
    `);
    type CampMetrics = { impressions: number; clicks: number; conversions: number; cost: number };
    const campaigns: Array<{ id: string; name: string; status: "ENABLED" | "PAUSED"; metrics: CampMetrics }> = [];
    const campNameById = new Map<string, string>();
    for (const r of campRows) {
      const id = String(r.campaign.id);
      const name = String(r.campaign.name);
      const st = STATUS_MAP[r.campaign.status];
      if (!st) continue;
      const m = r.metrics ?? {};
      campaigns.push({
        id,
        name,
        status: st,
        metrics: {
          impressions: Number(m.impressions ?? 0),
          clicks: Number(m.clicks ?? 0),
          conversions: Number(m.conversions ?? 0),
          cost: Number(m.costMicros ?? 0) / 1e6,
        },
      });
      campNameById.set(id, name);
    }
    // Also fetch campaigns that have 0 impressions (date-filtered query skips them)
    // — important for showing all enabled campaigns even on quiet days.
    const allCampRows = await search(`
      SELECT campaign.id, campaign.name, campaign.status
      FROM campaign
      WHERE campaign.status != 'REMOVED'
    `);
    for (const r of allCampRows) {
      const id = String(r.campaign.id);
      if (campNameById.has(id)) continue;
      const st = STATUS_MAP[r.campaign.status];
      if (!st) continue;
      campaigns.push({
        id,
        name: String(r.campaign.name),
        status: st,
        metrics: { impressions: 0, clicks: 0, conversions: 0, cost: 0 },
      });
      campNameById.set(id, String(r.campaign.name));
    }

    // 2) Ad groups (with date-scoped metrics + URL suffix)
    const agRows = await search(`
      SELECT
        ad_group.id, ad_group.name, ad_group.status, ad_group.final_url_suffix,
        campaign.id,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM ad_group
      WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'
        AND segments.date ${dateSql}
    `);

    // 3) Ads (RSA only) — full details
    const adRows = await search(`
      SELECT
        ad_group_ad.ad.id,
        ad_group_ad.ad.final_urls,
        ad_group_ad.ad.responsive_search_ad.headlines,
        ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.responsive_search_ad.path1,
        ad_group_ad.ad.responsive_search_ad.path2,
        ad_group_ad.ad_strength,
        ad_group_ad.status,
        ad_group.id,
        ad_group.name,
        campaign.id
      FROM ad_group_ad
      WHERE ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED'
    `);

    // 4) Keywords (positive) — with date-scoped metrics + QS + bid + final URLs
    const kwRows = await search(`
      SELECT
        ad_group_criterion.criterion_id,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.status,
        ad_group_criterion.cpc_bid_micros,
        ad_group_criterion.effective_cpc_bid_micros,
        ad_group_criterion.final_urls,
        ad_group_criterion.final_url_suffix,
        ad_group_criterion.quality_info.quality_score,
        ad_group.id,
        ad_group.name,
        ad_group.final_url_suffix,
        campaign.id,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM keyword_view
      WHERE ad_group_criterion.status != 'REMOVED'
        AND campaign.status != 'REMOVED'
        AND segments.date ${dateSql}
    `);

    // 5) Negatives — campaign-level
    const negCampRows = await search(`
      SELECT
        campaign_criterion.criterion_id,
        campaign_criterion.keyword.text,
        campaign_criterion.keyword.match_type,
        campaign_criterion.status,
        campaign.id
      FROM campaign_criterion
      WHERE campaign_criterion.type = 'KEYWORD'
        AND campaign_criterion.negative = TRUE
        AND campaign_criterion.status != 'REMOVED'
        AND campaign.status != 'REMOVED'
    `);

    // 6) Negatives — ad-group-level
    const negAgRows = await search(`
      SELECT
        ad_group_criterion.criterion_id,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.status,
        ad_group.id,
        ad_group.name,
        campaign.id
      FROM ad_group_criterion
      WHERE ad_group_criterion.type = 'KEYWORD'
        AND ad_group_criterion.negative = TRUE
        AND ad_group_criterion.status != 'REMOVED'
        AND campaign.status != 'REMOVED'
    `);

    type AdDetails = {
      finalUrls: string[];
      headlines: Array<{ text: string; pinned?: string }>;
      descriptions: Array<{ text: string; pinned?: string }>;
      path1?: string;
      path2?: string;
      adStrength?: string;
    };
    type EntityRow = {
      id: string;
      type: "campaign" | "ad_group" | "ad" | "keyword" | "negative";
      status: "ENABLED" | "PAUSED";
      campaignId: string;
      campaignName: string;
      adGroupId?: string;
      title: string;
      suffix?: string;
      impressions?: number;
      clicks?: number;
      conversions?: number;
      cost?: number;
      qualityScore?: number;
      bid?: number;
      ad?: AdDetails;
    };

    const entities: EntityRow[] = [];

    for (const c of campaigns) {
      entities.push({
        id: c.id,
        type: "campaign",
        status: c.status,
        campaignId: c.id,
        campaignName: c.name,
        title: c.name,
        impressions: c.metrics.impressions,
        clicks: c.metrics.clicks,
        conversions: c.metrics.conversions,
        cost: c.metrics.cost,
      });
    }
    for (const r of agRows) {
      const cId = String(r.campaign.id);
      const st = STATUS_MAP[r.adGroup.status];
      if (!st) continue;
      const m = r.metrics ?? {};
      entities.push({
        id: String(r.adGroup.id),
        type: "ad_group",
        status: st,
        campaignId: cId,
        campaignName: campNameById.get(cId) ?? "",
        adGroupId: String(r.adGroup.id),
        title: String(r.adGroup.name),
        suffix: r.adGroup.finalUrlSuffix || undefined,
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        cost: Number(m.costMicros ?? 0) / 1e6,
      });
    }
    for (const r of adRows) {
      const cId = String(r.campaign.id);
      const st = STATUS_MAP[r.adGroupAd.status];
      if (!st) continue;
      const rsa = r.adGroupAd?.ad?.responsiveSearchAd ?? {};
      const heads: any[] = rsa.headlines ?? [];
      const descs: any[] = rsa.descriptions ?? [];
      const titleText = heads[0]?.text ? heads[0].text : `Ad ${r.adGroupAd.ad.id}`;
      entities.push({
        id: String(r.adGroupAd.ad.id),
        type: "ad",
        status: st,
        campaignId: cId,
        campaignName: campNameById.get(cId) ?? "",
        adGroupId: String(r.adGroup.id),
        title: titleText,
        ad: {
          finalUrls: r.adGroupAd?.ad?.finalUrls ?? [],
          headlines: heads.map((h: any) => ({ text: h.text ?? "", pinned: h.pinnedField })),
          descriptions: descs.map((d: any) => ({ text: d.text ?? "", pinned: d.pinnedField })),
          path1: rsa.path1 || undefined,
          path2: rsa.path2 || undefined,
          adStrength: r.adGroupAd?.adStrength,
        },
      });
    }
    // keyword_view returns positive AND negative ad-group keywords. Filter
    // negatives out — we treat them as type=negative below via the dedicated
    // negative queries.
    for (const r of kwRows) {
      if (r.adGroupCriterion.negative === true) continue;
      const cId = String(r.campaign.id);
      const st = STATUS_MAP[r.adGroupCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.adGroupCriterion.keyword.matchType] ?? "?";
      const m = r.metrics ?? {};
      const bidMicros = r.adGroupCriterion.cpcBidMicros ?? r.adGroupCriterion.effectiveCpcBidMicros;
      const qs = r.adGroupCriterion.qualityInfo?.qualityScore;
      entities.push({
        id: String(r.adGroupCriterion.criterionId),
        type: "keyword",
        status: st,
        campaignId: cId,
        campaignName: campNameById.get(cId) ?? "",
        adGroupId: String(r.adGroup.id),
        title: `[${mt}] "${r.adGroupCriterion.keyword.text}" · ${r.adGroup.name}`,
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        cost: Number(m.costMicros ?? 0) / 1e6,
        qualityScore: typeof qs === "number" ? qs : undefined,
        bid: bidMicros ? Number(bidMicros) / 1e6 : undefined,
        suffix:
          (Array.isArray(r.adGroupCriterion.finalUrls) && r.adGroupCriterion.finalUrls[0]) ||
          r.adGroupCriterion.finalUrlSuffix ||
          r.adGroup.finalUrlSuffix ||
          undefined,
      });
    }
    for (const r of negCampRows) {
      const cId = String(r.campaign.id);
      const st = STATUS_MAP[r.campaignCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.campaignCriterion.keyword.matchType] ?? "?";
      entities.push({
        id: `c-${r.campaignCriterion.criterionId}`,
        type: "negative",
        status: st,
        campaignId: cId,
        campaignName: campNameById.get(cId) ?? "",
        title: `[${mt}] "${r.campaignCriterion.keyword.text}" · campaign-level`,
      });
    }
    for (const r of negAgRows) {
      const cId = String(r.campaign.id);
      const st = STATUS_MAP[r.adGroupCriterion.status];
      if (!st) continue;
      const mt = MT_LABEL[r.adGroupCriterion.keyword.matchType] ?? "?";
      entities.push({
        id: `ag-${r.adGroupCriterion.criterionId}`,
        type: "negative",
        status: st,
        campaignId: cId,
        campaignName: campNameById.get(cId) ?? "",
        adGroupId: String(r.adGroup.id),
        title: `[${mt}] "${r.adGroupCriterion.keyword.text}" · ${r.adGroup.name}`,
      });
    }

    // Apply filters
    const filtered = entities.filter((e) => {
      if (filterCampaignId && e.campaignId !== filterCampaignId) return false;
      if (filterStatus && e.status !== filterStatus) return false;
      if (filterType && e.type !== filterType) return false;
      return true;
    });

    // Per-campaign hourly buckets. Hour granularity works on campaign resource
    // (keyword_view doesn't allow segments.hour, so we drop keyword detail).
    const useHour = filterDateRange !== "last7days";
    const tlRows = await search(`
      SELECT
        segments.date${useHour ? ", segments.hour" : ""},
        metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE segments.date ${dateSql}
        AND metrics.impressions > 0
    `);

    const tlMap = new Map<string, { time: string; impressions: number; clicks: number; conversions: number; cost: number }>();
    for (const r of tlRows) {
      const date = r.segments?.date;
      const hour = r.segments?.hour;
      const time = useHour
        ? `${date} ${String(hour).padStart(2, "0")}:00`
        : String(date);
      const b = tlMap.get(time) ?? { time, impressions: 0, clicks: 0, conversions: 0, cost: 0 };
      b.impressions += Number(r.metrics?.impressions ?? 0);
      b.clicks += Number(r.metrics?.clicks ?? 0);
      b.conversions += Number(r.metrics?.conversions ?? 0);
      b.cost += Number(r.metrics?.costMicros ?? 0) / 1e6;
      tlMap.set(time, b);
    }
    const timeline = Array.from(tlMap.values()).sort((a, b) => (a.time > b.time ? -1 : 1));

    // Campaign-level assets (sitelinks, business names, images, logos)
    const campIdsCsv = campaigns.map((c) => c.id).join(",");
    type CampAssets = {
      businessNames: string[];
      sitelinks: Array<{ title: string; desc1?: string; desc2?: string }>;
      imageCount: number;
      logoCount: number;
    };
    const campaignAssets: Record<string, CampAssets> = {};
    if (campIdsCsv) {
      const assetRows = await search(`
        SELECT
          campaign.id,
          asset.id, asset.type, asset.name,
          asset.sitelink_asset.link_text,
          asset.sitelink_asset.description1,
          asset.sitelink_asset.description2,
          campaign_asset.field_type,
          campaign_asset.status
        FROM campaign_asset
        WHERE campaign.id IN (${campIdsCsv})
          AND campaign_asset.status = 'ENABLED'
      `);
      for (const r of assetRows) {
        const cId = String(r.campaign.id);
        const a = campaignAssets[cId] ?? {
          businessNames: [],
          sitelinks: [],
          imageCount: 0,
          logoCount: 0,
        };
        const ft = r.campaignAsset?.fieldType;
        if (ft === "SITELINK" && r.asset?.sitelinkAsset?.linkText) {
          a.sitelinks.push({
            title: r.asset.sitelinkAsset.linkText,
            desc1: r.asset.sitelinkAsset.description1,
            desc2: r.asset.sitelinkAsset.description2,
          });
        } else if (ft === "BUSINESS_NAME" && r.asset?.name) {
          a.businessNames.push(r.asset.name);
        } else if (ft === "BUSINESS_LOGO" || ft === "LOGO") {
          a.logoCount += 1;
        } else if (ft === "MARKETING_IMAGE" || ft === "SQUARE_MARKETING_IMAGE" || ft === "PORTRAIT_MARKETING_IMAGE") {
          a.imageCount += 1;
        }
        campaignAssets[cId] = a;
      }
    }

    return {
      campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })),
      entities: filtered,
      timeline,
      campaignAssets,
    };
  }

  /** Keyword Planner stats for an arbitrary phrase with explicit geo + language. */
  @Get("google-ads/planner")
  async planner(
    @Query("phrase") phrase?: string,
    @Query("geo") geo?: string,
    @Query("language") language?: string,
  ) {
    const phraseTrim = (phrase ?? "").trim();
    if (!phraseTrim) throw new BadRequestException("phrase is required");
    const geos = geo ? geo.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const lang = language && language.trim() ? language.trim() : null;

    const idea = await this.fetchKeywordIdea(phraseTrim, geos, lang);
    const metrics = idea?.keywordIdeaMetrics ?? null;

    const MONTH_NUM: Record<string, number> = {
      JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
      JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
    };
    const rawVols: Array<{ year?: string; month?: string; monthlySearches?: string }> = metrics?.monthlySearchVolumes ?? [];
    const vols = rawVols
      .map((v) => ({
        year: Number(v.year ?? 0),
        monthName: v.month ?? "",
        monthNum: MONTH_NUM[v.month ?? ""] ?? 0,
        searches: Number(v.monthlySearches ?? 0),
      }))
      .filter((v) => v.year > 0 && v.monthNum > 0)
      .sort((a, b) => (a.year - b.year) || (a.monthNum - b.monthNum));

    let minMonth: typeof vols[number] | null = null;
    let maxMonth: typeof vols[number] | null = null;
    if (vols.length) {
      minMonth = vols.reduce((a, b) => (a.searches <= b.searches ? a : b));
      maxMonth = vols.reduce((a, b) => (a.searches >= b.searches ? a : b));
    }

    let yoyPct: number | null = null;
    if (vols.length >= 12) {
      const last3 = vols.slice(-3).reduce((s, v) => s + v.searches, 0);
      const prev3 = vols.slice(-12, -9).reduce((s, v) => s + v.searches, 0);
      if (prev3 > 0) yoyPct = ((last3 - prev3) / prev3) * 100;
    }

    return {
      keyword: phraseTrim,
      geoTargets: geos,
      language: lang,
      avgMonthlySearches: metrics?.avgMonthlySearches != null ? Number(metrics.avgMonthlySearches) : null,
      competition: metrics?.competition ?? null,
      competitionIndex: metrics?.competitionIndex != null ? Number(metrics.competitionIndex) : null,
      lowTopOfPageBidMicros: metrics?.lowTopOfPageBidMicros != null ? Number(metrics.lowTopOfPageBidMicros) : null,
      highTopOfPageBidMicros: metrics?.highTopOfPageBidMicros != null ? Number(metrics.highTopOfPageBidMicros) : null,
      monthlySearchVolumes: vols,
      minMonth,
      maxMonth,
      yoyPct,
      foundExactMatch: idea ? (idea.text ?? "").toLowerCase() === phraseTrim.toLowerCase() : false,
    };
  }

  /** Add a new keyword to an ad group (or a campaign-level negative). */
  @Post("google-ads/keyword/:adGroupId")
  @HttpCode(HttpStatus.OK)
  async addKeyword(
    @Param("adGroupId") adGroupId: string,
    @Body() body: { text?: string; matchType?: string; negative?: boolean; bidMicros?: number },
  ) {
    const text = (body?.text ?? "").trim();
    const matchType = (body?.matchType ?? "").trim().toUpperCase();
    const negative = body?.negative === true;
    const bidMicrosRaw = body?.bidMicros;
    const bidMicros = typeof bidMicrosRaw === "number" && Number.isFinite(bidMicrosRaw) && bidMicrosRaw > 0
      ? Math.round(bidMicrosRaw)
      : null;
    if (!text) throw new BadRequestException("text is required");
    if (!["EXACT", "PHRASE", "BROAD"].includes(matchType)) {
      throw new BadRequestException("matchType must be EXACT, PHRASE or BROAD");
    }
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };

    if (negative) {
      const { search } = await this.gadsClient();
      const [agRow] = await search(`SELECT campaign.id FROM ad_group WHERE ad_group.id = ${adGroupId}`);
      const campaignId: string = agRow?.campaign?.id ?? "";
      if (!campaignId) throw new NotFoundException("Campaign not found for ad group");
      const res = await fetch(
        `https://googleads.googleapis.com/v23/customers/${CUST}/campaignCriteria:mutate`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operations: [{
              create: {
                campaign: `customers/${CUST}/campaigns/${campaignId}`,
                negative: true,
                keyword: { text, matchType },
              },
            }],
          }),
        },
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new BadRequestException(`Add negative failed: ${txt.slice(0, 500)}`);
      }
      const j = await res.json();
      return { ok: true, scope: "campaign_negative", result: j };
    }

    const create: Record<string, unknown> = {
      adGroup: `customers/${CUST}/adGroups/${adGroupId}`,
      status: "ENABLED",
      keyword: { text, matchType },
    };
    if (bidMicros != null) create.cpcBidMicros = bidMicros;
    const res = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupCriteria:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ operations: [{ create }] }),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new BadRequestException(`Add keyword failed: ${txt.slice(0, 500)}`);
    }
    const j = await res.json();
    return { ok: true, scope: "ad_group", result: j };
  }

  /** Delete a keyword (remove ad_group_criterion). */
  @Delete("google-ads/keyword/:adGroupId/:critId")
  async deleteKeyword(
    @Param("adGroupId") adGroupId: string,
    @Param("critId") critId: string,
  ) {
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    const CUST = "6803239831";
    const resourceName = `customers/${CUST}/adGroupCriteria/${adGroupId}~${critId}`;
    const res = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupCriteria:mutate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operations: [{ remove: resourceName }] }),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new BadRequestException(`Delete keyword failed: ${txt.slice(0, 500)}`);
    }
    return { ok: true };
  }

  /**
   * Validate + normalise the `ad` sub-payload of POST/PATCH ad-group.
   * Returns a `responsive_search_ad` body fragment ready for adGroupAds:mutate.
   */
  private normalizeAdPayload(ad: unknown): {
    finalUrl: string;
    headlines: Array<{ text: string; pinnedField?: string }>;
    descriptions: Array<{ text: string; pinnedField?: string }>;
    path1?: string;
    path2?: string;
  } {
    if (!ad || typeof ad !== "object") {
      throw new BadRequestException("ad payload invalid");
    }
    const a = ad as Record<string, unknown>;
    const finalUrl = String(a.finalUrl ?? "").trim();
    if (!finalUrl || !/^https?:\/\//.test(finalUrl)) {
      throw new BadRequestException("ad.finalUrl required, must be http(s) URL");
    }
    if (finalUrl.length > 2048) {
      throw new BadRequestException("ad.finalUrl too long (max 2048)");
    }
    const headlinesRaw = Array.isArray(a.headlines) ? a.headlines : null;
    if (!headlinesRaw) throw new BadRequestException("ad.headlines required");
    const headlines: Array<{ text: string; pinnedField?: string }> = [];
    for (const h of headlinesRaw as Array<Record<string, unknown>>) {
      const text = String(h?.text ?? "").trim();
      if (!text) continue;
      if (text.length > 30) {
        throw new BadRequestException(`headline >30 chars: "${text}"`);
      }
      const pin = h?.pin;
      const entry: { text: string; pinnedField?: string } = { text };
      if (pin === "HEADLINE_1" || pin === "HEADLINE_2" || pin === "HEADLINE_3") {
        entry.pinnedField = pin;
      }
      headlines.push(entry);
    }
    if (headlines.length < 3 || headlines.length > 15) {
      throw new BadRequestException(`headlines must be 3-15 (got ${headlines.length})`);
    }
    const descriptionsRaw = Array.isArray(a.descriptions) ? a.descriptions : null;
    if (!descriptionsRaw) throw new BadRequestException("ad.descriptions required");
    const descriptions: Array<{ text: string; pinnedField?: string }> = [];
    for (const d of descriptionsRaw as Array<Record<string, unknown>>) {
      const text = String(d?.text ?? "").trim();
      if (!text) continue;
      if (text.length > 90) {
        throw new BadRequestException(`description >90 chars: "${text}"`);
      }
      const pin = d?.pin;
      const entry: { text: string; pinnedField?: string } = { text };
      if (pin === "DESCRIPTION_1" || pin === "DESCRIPTION_2") {
        entry.pinnedField = pin;
      }
      descriptions.push(entry);
    }
    if (descriptions.length < 2 || descriptions.length > 4) {
      throw new BadRequestException(`descriptions must be 2-4 (got ${descriptions.length})`);
    }
    const path1Raw = typeof a.path1 === "string" ? a.path1.trim() : "";
    const path2Raw = typeof a.path2 === "string" ? a.path2.trim() : "";
    if (path1Raw.length > 15) throw new BadRequestException("path1 max 15 chars");
    if (path2Raw.length > 15) throw new BadRequestException("path2 max 15 chars");
    return {
      finalUrl,
      headlines,
      descriptions,
      path1: path1Raw || undefined,
      path2: path2Raw || undefined,
    };
  }

  /** Pause every ENABLED ad inside the given ad-group via adGroupAds:mutate. */
  private async pauseEnabledAdsInGroup(
    adGroupId: string,
    token: string,
    developerToken: string,
    loginCustomerId: string | undefined,
    customerId: string,
  ): Promise<void> {
    const { search } = await this.gadsClient();
    const rows = await search(
      `SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE ad_group.id = ${adGroupId} AND ad_group_ad.status = 'ENABLED'`,
    );
    if (rows.length === 0) return;
    const operations = rows.map((r) => ({
      updateMask: "status",
      update: {
        resourceName: (r as { adGroupAd: { resourceName: string } }).adGroupAd.resourceName,
        status: "PAUSED",
      },
    }));
    const res = await fetch(
      `https://googleads.googleapis.com/v23/customers/${customerId}/adGroupAds:mutate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operations }),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new BadRequestException(`Pause existing ads failed: ${txt.slice(0, 500)}`);
    }
  }

  /** Create a new ENABLED RSA in the given ad-group. Returns the new ad id. */
  private async createRsaInAdGroup(
    adGroupId: string,
    normalized: ReturnType<AdminController["normalizeAdPayload"]>,
    token: string,
    developerToken: string,
    loginCustomerId: string | undefined,
    customerId: string,
  ): Promise<string> {
    const adGroupResource = `customers/${customerId}/adGroups/${adGroupId}`;
    const responsiveSearchAd: Record<string, unknown> = {
      headlines: normalized.headlines,
      descriptions: normalized.descriptions,
    };
    if (normalized.path1) responsiveSearchAd.path1 = normalized.path1;
    if (normalized.path2) responsiveSearchAd.path2 = normalized.path2;
    const res = await fetch(
      `https://googleads.googleapis.com/v23/customers/${customerId}/adGroupAds:mutate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operations: [{
            create: {
              adGroup: adGroupResource,
              status: "ENABLED",
              ad: {
                finalUrls: [normalized.finalUrl],
                responsiveSearchAd,
              },
            },
          }],
        }),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new BadRequestException(`Ad create failed: ${txt.slice(0, 500)}`);
    }
    const j = (await res.json()) as { results?: Array<{ resourceName?: string }> };
    const resourceName = j.results?.[0]?.resourceName ?? "";
    return resourceName.split("/").pop() ?? "";
  }

  /**
   * Create an ad group inside a campaign. Optionally also create a single
   * RSA inside the new group (when `ad` is present in the body) — used by
   * the merged "ad group + ad" UI flow.
   */
  @Post("google-ads/ad-group/:campaignId")
  @HttpCode(HttpStatus.OK)
  async createAdGroup(
    @Param("campaignId") campaignId: string,
    @Body()
    body: {
      name?: string;
      defaultBidMicros?: number;
      finalUrlSuffix?: string;
      ad?: unknown;
    },
  ) {
    const name = (body?.name ?? "").trim();
    if (!name) throw new BadRequestException("name required");
    const cleanCampaignId = String(campaignId).trim();
    if (!/^\d+$/.test(cleanCampaignId)) {
      throw new BadRequestException("campaignId must be numeric");
    }
    // Validate ad payload up-front (fail-fast before creating ad-group).
    const normalizedAd = body?.ad !== undefined && body.ad !== null
      ? this.normalizeAdPayload(body.ad)
      : null;
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const create: Record<string, unknown> = {
      campaign: `customers/${CUST}/campaigns/${cleanCampaignId}`,
      name,
      status: "ENABLED",
      type: "SEARCH_STANDARD",
    };
    if (Number.isFinite(body?.defaultBidMicros) && Number(body!.defaultBidMicros) > 0) {
      create.cpcBidMicros = Math.round(Number(body!.defaultBidMicros));
    }
    if (typeof body?.finalUrlSuffix === "string" && body.finalUrlSuffix.length > 0) {
      create.finalUrlSuffix = body.finalUrlSuffix.slice(0, 2048);
    }
    const agRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroups:mutate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operations: [{ create }] }),
      },
    );
    if (!agRes.ok) {
      const txt = await agRes.text();
      throw new BadRequestException(`Ad group create failed: ${txt.slice(0, 500)}`);
    }
    const agJson = (await agRes.json()) as { results?: Array<{ resourceName?: string }> };
    const adGroupResource = agJson.results?.[0]?.resourceName ?? "";
    const adGroupId = adGroupResource.split("/").pop() ?? "";

    let adId: string | undefined;
    if (normalizedAd) {
      adId = await this.createRsaInAdGroup(
        adGroupId,
        normalizedAd,
        token,
        developerToken,
        loginCustomerId,
        CUST,
      );
    }
    return { ok: true, adGroupId, adId };
  }

  /**
   * Update an ad group's name / status / default bid / suffix. Optional
   * `ad` block triggers replace-pattern: all ENABLED ads in the group are
   * PAUSED and a fresh RSA is created (RSAs are immutable in Google Ads).
   */
  @Patch("google-ads/ad-group/:adGroupId")
  @HttpCode(HttpStatus.OK)
  async updateAdGroup(
    @Param("adGroupId") adGroupId: string,
    @Body()
    body: {
      name?: string;
      defaultBidMicros?: number | null;
      finalUrlSuffix?: string | null;
      status?: "ENABLED" | "PAUSED";
      ad?: unknown;
    },
  ) {
    const cleanId = String(adGroupId).trim();
    if (!/^\d+$/.test(cleanId)) {
      throw new BadRequestException("adGroupId must be numeric");
    }
    // Validate ad payload up-front (fail-fast before mutating anything).
    const normalizedAd = body?.ad !== undefined && body.ad !== null
      ? this.normalizeAdPayload(body.ad)
      : null;
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const CUST = "6803239831";
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");

    // Update ad-group-level fields if any were provided.
    const resourceName = `customers/${CUST}/adGroups/${cleanId}`;
    const update: Record<string, unknown> = { resourceName };
    const maskFields: string[] = [];
    if (typeof body?.name === "string") {
      const n = body.name.trim();
      if (!n) throw new BadRequestException("name cannot be empty");
      update.name = n;
      maskFields.push("name");
    }
    if (body?.defaultBidMicros === null) {
      update.cpcBidMicros = 0;
      maskFields.push("cpc_bid_micros");
    } else if (Number.isFinite(body?.defaultBidMicros) && Number(body!.defaultBidMicros) > 0) {
      update.cpcBidMicros = Math.round(Number(body!.defaultBidMicros));
      maskFields.push("cpc_bid_micros");
    }
    if (body?.finalUrlSuffix === null) {
      update.finalUrlSuffix = "";
      maskFields.push("final_url_suffix");
    } else if (typeof body?.finalUrlSuffix === "string") {
      update.finalUrlSuffix = body.finalUrlSuffix.slice(0, 2048);
      maskFields.push("final_url_suffix");
    }
    if (body?.status === "ENABLED" || body?.status === "PAUSED") {
      update.status = body.status;
      maskFields.push("status");
    }
    if (maskFields.length > 0) {
      const res = await fetch(
        `https://googleads.googleapis.com/v23/customers/${CUST}/adGroups:mutate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "developer-token": developerToken,
            ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            operations: [{ updateMask: maskFields.join(","), update }],
          }),
        },
      );
      if (!res.ok) {
        const txt = await res.text();
        throw new BadRequestException(`Ad group update failed: ${txt.slice(0, 500)}`);
      }
    }

    // Replace ad: pause existing ENABLED ads, create a fresh RSA.
    let newAdId: string | undefined;
    if (normalizedAd) {
      await this.pauseEnabledAdsInGroup(cleanId, token, developerToken, loginCustomerId, CUST);
      newAdId = await this.createRsaInAdGroup(
        cleanId,
        normalizedAd,
        token,
        developerToken,
        loginCustomerId,
        CUST,
      );
    }

    if (maskFields.length === 0 && !normalizedAd) {
      throw new BadRequestException("no fields to update");
    }
    return { ok: true, newAdId };
  }

  /**
   * Create a sitelink asset and attach it to the given ad group.
   * Body: { linkText, description1?, description2?, finalUrl }
   */
  @Post("google-ads/ad-group/:adGroupId/sitelink")
  @HttpCode(HttpStatus.OK)
  async createAdGroupSitelink(
    @Param("adGroupId") adGroupId: string,
    @Body() body: { linkText?: string; description1?: string; description2?: string; finalUrl?: string },
  ) {
    const cleanId = String(adGroupId).trim();
    if (!/^\d+$/.test(cleanId)) throw new BadRequestException("adGroupId must be numeric");
    const linkText = (body?.linkText ?? "").trim();
    const finalUrl = (body?.finalUrl ?? "").trim();
    if (!linkText) throw new BadRequestException("linkText required");
    if (linkText.length > 25) throw new BadRequestException("linkText max 25 chars");
    if (!finalUrl || !/^https?:\/\//.test(finalUrl)) throw new BadRequestException("finalUrl required, http(s)");
    const desc1 = typeof body?.description1 === "string" ? body.description1.trim().slice(0, 35) : undefined;
    const desc2 = typeof body?.description2 === "string" ? body.description2.trim().slice(0, 35) : undefined;
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };
    // 1. Create the sitelink asset.
    const sitelink: Record<string, unknown> = { linkText };
    if (desc1) sitelink.description1 = desc1;
    if (desc2) sitelink.description2 = desc2;
    const assetRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/assets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            create: {
              sitelinkAsset: sitelink,
              finalUrls: [finalUrl],
            },
          }],
        }),
      },
    );
    if (!assetRes.ok) {
      const txt = await assetRes.text();
      throw new BadRequestException(`Sitelink asset create failed: ${txt.slice(0, 500)}`);
    }
    const assetJson = (await assetRes.json()) as { results?: Array<{ resourceName?: string }> };
    const assetResource = assetJson.results?.[0]?.resourceName ?? "";
    const assetId = assetResource.split("/").pop() ?? "";
    // 2. Attach to ad-group.
    const linkRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupAssets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            create: {
              adGroup: `customers/${CUST}/adGroups/${cleanId}`,
              asset: assetResource,
              fieldType: "SITELINK",
            },
          }],
        }),
      },
    );
    if (!linkRes.ok) {
      const txt = await linkRes.text();
      throw new BadRequestException(`Sitelink attach failed: ${txt.slice(0, 500)}`);
    }
    return { ok: true, assetId };
  }

  /** Detach + delete a sitelink asset from an ad group. */
  @Delete("google-ads/ad-group/:adGroupId/sitelink/:assetId")
  @HttpCode(HttpStatus.OK)
  async deleteAdGroupSitelink(
    @Param("adGroupId") adGroupId: string,
    @Param("assetId") assetId: string,
  ) {
    const cleanAg = String(adGroupId).trim();
    const cleanAsset = String(assetId).trim();
    if (!/^\d+$/.test(cleanAg)) throw new BadRequestException("adGroupId must be numeric");
    if (!/^\d+$/.test(cleanAsset)) throw new BadRequestException("assetId must be numeric");
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };
    // 1. Detach ad-group-asset link.
    const linkRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupAssets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            remove: `customers/${CUST}/adGroupAssets/${cleanAg}~${cleanAsset}~SITELINK`,
          }],
        }),
      },
    );
    if (!linkRes.ok) {
      const txt = await linkRes.text();
      throw new BadRequestException(`Sitelink detach failed: ${txt.slice(0, 500)}`);
    }
    // 2. Best-effort: delete the orphan asset itself (ignore if it's still referenced elsewhere).
    try {
      await fetch(
        `https://googleads.googleapis.com/v23/customers/${CUST}/assets:mutate`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operations: [{ remove: `customers/${CUST}/assets/${cleanAsset}` }],
          }),
        },
      );
    } catch {
      // best-effort cleanup, don't fail if the asset can't be removed
    }
    return { ok: true };
  }

  /**
   * Create a callout asset and attach it to the given ad group.
   * Body: { calloutText }
   */
  @Post("google-ads/ad-group/:adGroupId/callout")
  @HttpCode(HttpStatus.OK)
  async createAdGroupCallout(
    @Param("adGroupId") adGroupId: string,
    @Body() body: { calloutText?: string },
  ) {
    const cleanId = String(adGroupId).trim();
    if (!/^\d+$/.test(cleanId)) throw new BadRequestException("adGroupId must be numeric");
    const calloutText = (body?.calloutText ?? "").trim();
    if (!calloutText) throw new BadRequestException("calloutText required");
    if (calloutText.length > 25) throw new BadRequestException("calloutText max 25 chars");
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };
    // 1. Create callout asset.
    const assetRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/assets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{ create: { calloutAsset: { calloutText } } }],
        }),
      },
    );
    if (!assetRes.ok) {
      const txt = await assetRes.text();
      throw new BadRequestException(`Callout asset create failed: ${txt.slice(0, 500)}`);
    }
    const assetJson = (await assetRes.json()) as { results?: Array<{ resourceName?: string }> };
    const assetResource = assetJson.results?.[0]?.resourceName ?? "";
    const assetId = assetResource.split("/").pop() ?? "";
    // 2. Attach to ad-group.
    const linkRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupAssets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            create: {
              adGroup: `customers/${CUST}/adGroups/${cleanId}`,
              asset: assetResource,
              fieldType: "CALLOUT",
            },
          }],
        }),
      },
    );
    if (!linkRes.ok) {
      const txt = await linkRes.text();
      throw new BadRequestException(`Callout attach failed: ${txt.slice(0, 500)}`);
    }
    return { ok: true, assetId };
  }

  /** Detach + delete a callout asset from an ad group. */
  @Delete("google-ads/ad-group/:adGroupId/callout/:assetId")
  @HttpCode(HttpStatus.OK)
  async deleteAdGroupCallout(
    @Param("adGroupId") adGroupId: string,
    @Param("assetId") assetId: string,
  ) {
    const cleanAg = String(adGroupId).trim();
    const cleanAsset = String(assetId).trim();
    if (!/^\d+$/.test(cleanAg)) throw new BadRequestException("adGroupId must be numeric");
    if (!/^\d+$/.test(cleanAsset)) throw new BadRequestException("assetId must be numeric");
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };
    const linkRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupAssets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            remove: `customers/${CUST}/adGroupAssets/${cleanAg}~${cleanAsset}~CALLOUT`,
          }],
        }),
      },
    );
    if (!linkRes.ok) {
      const txt = await linkRes.text();
      throw new BadRequestException(`Callout detach failed: ${txt.slice(0, 500)}`);
    }
    try {
      await fetch(
        `https://googleads.googleapis.com/v23/customers/${CUST}/assets:mutate`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operations: [{ remove: `customers/${CUST}/assets/${cleanAsset}` }],
          }),
        },
      );
    } catch {
      // best-effort
    }
    return { ok: true };
  }

  /**
   * Create a structured-snippet asset and attach it to the given ad group.
   * Body: { header, values: string[] }
   * header must be a Google Ads SnippetHeader enum value (e.g. TYPES,
   * STYLES, SERVICE_CATALOG, BRANDS, MODELS, AMENITIES, COURSES, ...).
   */
  @Post("google-ads/ad-group/:adGroupId/snippet")
  @HttpCode(HttpStatus.OK)
  async createAdGroupSnippet(
    @Param("adGroupId") adGroupId: string,
    @Body() body: { header?: string; values?: string[] },
  ) {
    const cleanId = String(adGroupId).trim();
    if (!/^\d+$/.test(cleanId)) throw new BadRequestException("adGroupId must be numeric");
    // StructuredSnippetAsset.header is a free-form string in the REST schema,
    // but Google validates it against a fixed list of localized display values
    // (https://developers.google.com/google-ads/api/reference/data/structured-snippet-headers).
    // The UI sends the proto-enum code (e.g. "SERVICE_CATALOG"); translate to
    // the English display string before forwarding — sending the enum code as
    // header yields INVALID_ARGUMENT 400.
    const HEADER_BY_CODE: Record<string, string> = {
      AMENITIES: "Amenities",
      BRANDS: "Brands",
      COURSES: "Courses",
      DEGREE_PROGRAMS: "Degree programs",
      DESTINATIONS: "Destinations",
      FEATURED_HOTELS: "Featured hotels",
      INSURANCE_COVERAGE: "Insurance coverage",
      MODELS: "Models",
      NEIGHBORHOODS: "Neighborhoods",
      SERVICE_CATALOG: "Service catalog",
      SHOW_TYPES: "Shows",
      STYLES: "Styles",
      TYPES: "Types",
    };
    const code = String(body?.header ?? "").trim().toUpperCase();
    const header = HEADER_BY_CODE[code];
    if (!header) {
      throw new BadRequestException(`header must be one of: ${Object.keys(HEADER_BY_CODE).join(", ")}`);
    }
    const valuesRaw = Array.isArray(body?.values) ? body.values : [];
    // NFC-normalize to fold any smart quotes / combined diacritics into the
    // canonical form Google expects, then dedupe — Google rejects asset
    // creation when the values array contains duplicates.
    const seen = new Set<string>();
    const values: string[] = [];
    for (const v of valuesRaw) {
      const s = String(v ?? "").normalize("NFC").trim();
      if (!s || s.length > 25) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      values.push(s);
    }
    if (values.length < 3 || values.length > 10) {
      throw new BadRequestException(`values must be 3-10 strings ≤25 chars (got ${values.length})`);
    }
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };
    const snippetBody = JSON.stringify({
      operations: [{ create: { structuredSnippetAsset: { header, values } } }],
    });
    const assetRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/assets:mutate`,
      { method: "POST", headers, body: snippetBody },
    );
    if (!assetRes.ok) {
      const txt = await assetRes.text();
      console.error("[snippet-create] payload:", snippetBody);
      console.error("[snippet-create] response:", txt);
      throw new BadRequestException(`Snippet asset create failed: ${txt.slice(0, 4000)}`);
    }
    const assetJson = (await assetRes.json()) as { results?: Array<{ resourceName?: string }> };
    const assetResource = assetJson.results?.[0]?.resourceName ?? "";
    const assetId = assetResource.split("/").pop() ?? "";
    const linkRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupAssets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            create: {
              adGroup: `customers/${CUST}/adGroups/${cleanId}`,
              asset: assetResource,
              fieldType: "STRUCTURED_SNIPPET",
            },
          }],
        }),
      },
    );
    if (!linkRes.ok) {
      const txt = await linkRes.text();
      throw new BadRequestException(`Snippet attach failed: ${txt.slice(0, 500)}`);
    }
    return { ok: true, assetId };
  }

  /** Detach + delete a structured-snippet asset from an ad group. */
  @Delete("google-ads/ad-group/:adGroupId/snippet/:assetId")
  @HttpCode(HttpStatus.OK)
  async deleteAdGroupSnippet(
    @Param("adGroupId") adGroupId: string,
    @Param("assetId") assetId: string,
  ) {
    const cleanAg = String(adGroupId).trim();
    const cleanAsset = String(assetId).trim();
    if (!/^\d+$/.test(cleanAg)) throw new BadRequestException("adGroupId must be numeric");
    if (!/^\d+$/.test(cleanAsset)) throw new BadRequestException("assetId must be numeric");
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };
    const linkRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupAssets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            remove: `customers/${CUST}/adGroupAssets/${cleanAg}~${cleanAsset}~STRUCTURED_SNIPPET`,
          }],
        }),
      },
    );
    if (!linkRes.ok) {
      const txt = await linkRes.text();
      throw new BadRequestException(`Snippet detach failed: ${txt.slice(0, 500)}`);
    }
    try {
      await fetch(
        `https://googleads.googleapis.com/v23/customers/${CUST}/assets:mutate`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operations: [{ remove: `customers/${CUST}/assets/${cleanAsset}` }],
          }),
        },
      );
    } catch {
      // best-effort
    }
    return { ok: true };
  }

  /**
   * Upload an image asset (base64-encoded) and attach it to the given ad group.
   * Body: { data: base64, fieldType: "MARKETING_IMAGE" | "SQUARE_MARKETING_IMAGE" | "LOGO" | "LANDSCAPE_LOGO" }
   */
  @Post("google-ads/ad-group/:adGroupId/image")
  @HttpCode(HttpStatus.OK)
  async createAdGroupImage(
    @Param("adGroupId") adGroupId: string,
    @Body() body: { data?: string; fieldType?: string; name?: string },
  ) {
    const cleanId = String(adGroupId).trim();
    if (!/^\d+$/.test(cleanId)) throw new BadRequestException("adGroupId must be numeric");
    const VALID_FIELDS = new Set(["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO"]);
    const fieldType = String(body?.fieldType ?? "").trim().toUpperCase();
    if (!VALID_FIELDS.has(fieldType)) {
      throw new BadRequestException(`fieldType must be one of: ${[...VALID_FIELDS].join(", ")}`);
    }
    const data = String(body?.data ?? "").trim();
    if (!data) throw new BadRequestException("data (base64) required");
    // 5 MB cap (Google's per-asset limit is 5120 KB).
    if (data.length > 7 * 1024 * 1024) {
      throw new BadRequestException("image too large (max ~5 MB)");
    }
    const name = (body?.name ?? `image-${Date.now()}`).slice(0, 100);
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };
    const assetRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/assets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            create: {
              name,
              type: "IMAGE",
              imageAsset: { data },
            },
          }],
        }),
      },
    );
    if (!assetRes.ok) {
      const txt = await assetRes.text();
      throw new BadRequestException(`Image asset upload failed: ${txt.slice(0, 500)}`);
    }
    const assetJson = (await assetRes.json()) as { results?: Array<{ resourceName?: string }> };
    const assetResource = assetJson.results?.[0]?.resourceName ?? "";
    const assetId = assetResource.split("/").pop() ?? "";
    const linkRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupAssets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            create: {
              adGroup: `customers/${CUST}/adGroups/${cleanId}`,
              asset: assetResource,
              fieldType,
            },
          }],
        }),
      },
    );
    if (!linkRes.ok) {
      const txt = await linkRes.text();
      console.error("[gads-image-attach] adGroupId:", cleanId, "fieldType:", fieldType, "assetResource:", assetResource);
      console.error("[gads-image-attach] response:", txt);
      throw new BadRequestException(`Image attach failed: ${txt.slice(0, 4000)}`);
    }
    return { ok: true, assetId };
  }

  /** Detach an image asset from an ad group. Asset is left in the account (it may be referenced elsewhere). */
  @Delete("google-ads/ad-group/:adGroupId/image/:assetId/:fieldType")
  @HttpCode(HttpStatus.OK)
  async deleteAdGroupImage(
    @Param("adGroupId") adGroupId: string,
    @Param("assetId") assetId: string,
    @Param("fieldType") fieldType: string,
  ) {
    const cleanAg = String(adGroupId).trim();
    const cleanAsset = String(assetId).trim();
    const VALID_FIELDS = new Set(["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO"]);
    const ft = String(fieldType ?? "").trim().toUpperCase();
    if (!/^\d+$/.test(cleanAg)) throw new BadRequestException("adGroupId must be numeric");
    if (!/^\d+$/.test(cleanAsset)) throw new BadRequestException("assetId must be numeric");
    if (!VALID_FIELDS.has(ft)) throw new BadRequestException("invalid fieldType");
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    if (!token) throw new BadRequestException("Failed to obtain OAuth token");
    const CUST = "6803239831";
    const headers = {
      Authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
      "Content-Type": "application/json",
    };
    const linkRes = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupAssets:mutate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          operations: [{
            remove: `customers/${CUST}/adGroupAssets/${cleanAg}~${cleanAsset}~${ft}`,
          }],
        }),
      },
    );
    if (!linkRes.ok) {
      const txt = await linkRes.text();
      throw new BadRequestException(`Image detach failed: ${txt.slice(0, 500)}`);
    }
    // Image assets are typically reused — don't auto-delete the asset itself.
    return { ok: true };
  }

  @Post("google-ads/keyword/:adGroupId/:critId/bid")
  @HttpCode(HttpStatus.OK)
  async updateKeywordBid(
    @Param("adGroupId") adGroupId: string,
    @Param("critId") critId: string,
    @Body() body: { bidMicros?: number },
  ) {
    const bidMicros = Number(body?.bidMicros);
    if (!Number.isFinite(bidMicros) || bidMicros <= 0) {
      throw new BadRequestException("bidMicros must be positive number");
    }
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    const CUST = "6803239831";
    const resourceName = `customers/${CUST}/adGroupCriteria/${adGroupId}~${critId}`;
    const res = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}/adGroupCriteria:mutate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operations: [{
            updateMask: "cpc_bid_micros",
            update: { resourceName, cpcBidMicros: Math.round(bidMicros) },
          }],
        }),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new BadRequestException(`Bid update failed: ${txt.slice(0, 500)}`);
    }
    return { ok: true, bidMicros: Math.round(bidMicros) };
  }

  private async fetchKeywordIdea(
    keyword: string,
    geoTargets: string[],
    language: string | null,
  ): Promise<any | null> {
    const clientId = this.config.get<string>("GOOGLE_ADS_CLIENT_ID");
    const clientSecret = this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    const refreshToken = this.config.get<string>("GOOGLE_ADS_REFRESH_TOKEN");
    const developerToken = this.config.get<string>("GOOGLE_ADS_DEVELOPER_TOKEN");
    const loginCustomerId = this.config.get<string>("GOOGLE_ADS_LOGIN_CUSTOMER_ID");
    if (!clientId || !clientSecret || !refreshToken || !developerToken) {
      throw new BadRequestException("Google Ads env vars not configured");
    }
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth.getAccessToken();
    const CUST = "6803239831";
    const body: Record<string, unknown> = {
      keywordPlanNetwork: "GOOGLE_SEARCH",
      keywordSeed: { keywords: [keyword] },
      includeAdultKeywords: false,
      pageSize: 100,
    };
    if (geoTargets.length) body.geoTargetConstants = geoTargets;
    if (language) body.language = language;

    const res = await fetch(
      `https://googleads.googleapis.com/v23/customers/${CUST}:generateKeywordIdeas`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new BadRequestException(`Keyword ideas failed: ${txt.slice(0, 500)}`);
    }
    const j = (await res.json()) as { results?: any[] };
    const lower = keyword.toLowerCase();
    const exact = (j.results ?? []).find((r) => (r.text ?? "").toLowerCase() === lower);
    return exact ?? j.results?.[0] ?? null;
  }

}

// ────────────────── helpers ──────────────────

async function parseGadsResponse(res: globalThis.Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return { _rawError: text.slice(0, 500) }; }
}

