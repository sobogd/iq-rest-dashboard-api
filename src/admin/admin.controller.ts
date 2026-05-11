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
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const companies = await this.prisma.company.findMany({
      select: {
        id: true,
        plan: true,
        subscriptionStatus: true,
        emailsSent: true,
        restaurants: { select: { title: true }, take: 1 },
        _count: { select: { categories: true, items: true, supportMessages: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const ids = companies.map((c) => c.id);
    const [monthly, today, lastVisits] = ids.length
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
          this.prisma.$queryRaw<{ companyId: string; last: Date | null }[]>`
            SELECT "companyId", MAX(at) AS last
            FROM usage_events
            WHERE "companyId" = ANY(${ids}::text[])
            GROUP BY "companyId"
          `,
        ])
      : [[], [], []];
    const monthlyMap = new Map(monthly.map((r) => [r.companyId, Number(r.count)]));
    const todayMap = new Map(today.map((r) => [r.companyId, Number(r.count)]));
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
      todayScans: todayMap.get(c.id) || 0,
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

    // Most-recent gclid across this company's usage events — drives conversion
    // upload buttons in the admin company-detail UI.
    const lastGclidEvent = await this.prisma.usageEvent.findFirst({
      where: { companyId: id, gclid: { not: null } },
      orderBy: { at: "desc" },
      select: { gclid: true },
    });

    return {
      id: company.id,
      name: company.name,
      createdAt: company.createdAt,
      gclid: lastGclidEvent?.gclid ?? null,
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
    const rows = await this.prisma.usageEvent.findMany({
      where,
      orderBy: [{ at: "desc" }, { id: "desc" }],
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

  @Post("usage/upload-conversion")
  @HttpCode(HttpStatus.OK)
  async uploadConversion(@Body() body: { gclid?: string; type?: string }) {
    const { gclid, type } = body;
    if (!gclid) throw new BadRequestException("gclid required");

    const CONVERSIONS: Record<string, { id: string }> = {
      T1: { id: "7596477974" },
      T2: { id: "7499129024" },
      T3: { id: "7596477518" },
    };
    const conv = CONVERSIONS[type ?? ""];
    if (!conv) throw new BadRequestException("type must be T1, T2 or T3");

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
    const DATE_DURING: Record<string, string> = { today: "TODAY", yesterday: "YESTERDAY", last7days: "LAST_7_DAYS" };
    const dateDuring = DATE_DURING[filterDateRange ?? "today"] ?? "TODAY";
    const { search } = await this.gadsClient();
    const STATUS_MAP: Record<string, "ENABLED" | "PAUSED"> = { ENABLED: "ENABLED", PAUSED: "PAUSED" };

    // Campaigns with metrics
    const campRows = await search(`
      SELECT campaign.id, campaign.name, campaign.status,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date DURING ${dateDuring}
    `);
    const campaigns: Array<any> = [];
    const seen = new Set<string>();
    for (const r of campRows) {
      const id = String(r.campaign.id);
      const st = STATUS_MAP[r.campaign.status];
      if (!st) continue;
      if (filterStatus && st !== filterStatus) continue;
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
      if (filterStatus && st !== filterStatus) continue;
      campaigns.push({ id, name: String(r.campaign.name), status: st, impressions: 0, clicks: 0, conversions: 0, cost: 0 });
    }

    // Timeline (aggregated across all campaigns)
    const useHour = filterDateRange !== "last7days";
    const tlRows = await search(`
      SELECT segments.date${useHour ? ", segments.hour" : ""},
        metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign WHERE segments.date DURING ${dateDuring} AND metrics.impressions > 0
    `);
    const tlMap = new Map<string, any>();
    for (const r of tlRows) {
      const date = r.segments?.date;
      const hour = r.segments?.hour;
      const time = useHour ? `${date} ${String(hour).padStart(2, "0")}:00` : String(date);
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
    const DATE_DURING: Record<string, string> = { today: "TODAY", yesterday: "YESTERDAY", last7days: "LAST_7_DAYS" };
    const dateDuring = DATE_DURING[filterDateRange ?? "today"] ?? "TODAY";
    const { search } = await this.gadsClient();
    const STATUS_MAP: Record<string, "ENABLED" | "PAUSED"> = { ENABLED: "ENABLED", PAUSED: "PAUSED" };

    const [campMeta] = await search(`SELECT campaign.id, campaign.name FROM campaign WHERE campaign.id = ${campaignId}`);
    if (!campMeta) throw new NotFoundException("Campaign not found");
    const campaign = { id: String(campMeta.campaign.id), name: String(campMeta.campaign.name) };

    const agRows = await search(`
      SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.final_url_suffix,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.id = ${campaignId}
        AND segments.date DURING ${dateDuring}
    `);
    const seen = new Set<string>();
    const adGroups: any[] = [];
    for (const r of agRows) {
      const st = STATUS_MAP[r.adGroup.status];
      if (!st) continue;
      if (filterStatus && st !== filterStatus) continue;
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
      if (filterStatus && st !== filterStatus) continue;
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
    const DATE_DURING: Record<string, string> = { today: "TODAY", yesterday: "YESTERDAY", last7days: "LAST_7_DAYS" };
    const dateDuring = DATE_DURING[filterDateRange ?? "today"] ?? "TODAY";
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
        AND segments.date DURING ${dateDuring}
    `);
    const keywords: any[] = [];
    for (const r of kwRows) {
      if (r.adGroupCriterion.negative === true) continue;
      const st = STATUS_MAP[r.adGroupCriterion.status];
      if (!st) continue;
      if (filterStatus && st !== filterStatus) continue;
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
      if (filterStatus && st !== filterStatus) continue;
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
      if (filterStatus && st !== filterStatus) continue;
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
      if (filterStatus && st !== filterStatus) continue;
      const mt = MT_LABEL[r.adGroupCriterion.keyword.matchType] ?? "?";
      negatives.push({
        id: `ag-${r.adGroupCriterion.criterionId}`,
        title: `[${mt}] "${r.adGroupCriterion.keyword.text}" · ${r.adGroup.name}`,
        status: st,
      });
    }
    return { negatives };
  }

  @Get("google-ads/entities")
  async listGoogleAdsEntities(
    @Query("campaignId") filterCampaignId?: string,
    @Query("status") filterStatus?: string,
    @Query("type") filterType?: string,
    @Query("dateRange") filterDateRange?: string,
  ) {
    const DATE_DURING: Record<string, string> = {
      today: "TODAY",
      yesterday: "YESTERDAY",
      last7days: "LAST_7_DAYS",
    };
    const dateDuring = DATE_DURING[filterDateRange ?? "today"] ?? "TODAY";
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
        AND segments.date DURING ${dateDuring}
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
        AND segments.date DURING ${dateDuring}
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
        AND segments.date DURING ${dateDuring}
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
      WHERE segments.date DURING ${dateDuring}
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

}

// ────────────────── helpers ──────────────────

async function parseGadsResponse(res: globalThis.Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return { _rawError: text.slice(0, 500) }; }
}

