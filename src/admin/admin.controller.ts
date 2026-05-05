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
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

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
    const [monthly, today, lastVisits] = ids.length
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
    const monthlyViews = await this.prisma.pageView.count({
      where: { companyId: id, createdAt: { gte: startOfMonth } },
    });

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
    if (template !== "welcome_personal") {
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

    await this.mail.sendWelcomePersonal({ email: owner.email, name, locale });

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

  /** Usage events for a single day (UTC), paginated for infinite scroll.
   *  20 events per page, ordered by id desc (cuid is time-sortable). */
  @Get("usage/timeline")
  async usageTimeline(
    @Query("date") dateRaw?: string,
    @Query("scope") scope: "all" | "anonymous" | "identified" = "all",
    @Query("companyId") companyId?: string,
    @Query("cursor") cursor?: string,
  ) {
    const day = parseDayUtc(dateRaw);
    const where: Prisma.UsageEventWhereInput = {
      at: { gte: day.from, lt: day.to },
    };
    if (companyId) {
      where.companyId = companyId;
    } else if (scope === "anonymous") {
      where.companyId = null;
    } else if (scope === "identified") {
      where.companyId = { not: null };
    }

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
      day: day.iso,
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

  // ────────────────── CONVERSION UPLOAD ──────────────────

  @Post("usage/upload-conversion")
  @HttpCode(HttpStatus.OK)
  async uploadConversion(@Body() body: { gclid?: string; type?: string }) {
    const { gclid, type } = body;
    if (!gclid) throw new BadRequestException("gclid required");

    const CONVERSIONS: Record<string, { id: string; value: number }> = {
      T1: { id: "7596477974", value: 1.20 },
      T2: { id: "7499129024", value: 8.00 },
      T3: { id: "7596477518", value: 80.00 },
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
      "https://googleads.googleapis.com/v18/customers/6803239831:uploadClickConversions",
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
            conversionValue: conv.value,
            currencyCode: "EUR",
          }],
          partialFailure: true,
        }),
      },
    );

    const json = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new BadRequestException(JSON.stringify(json));
    return { ok: true, type, result: json };
  }
}

// ────────────────── helpers ──────────────────

/** Single UTC day window. Accepts "YYYY-MM-DD"; defaults to today UTC. */
function parseDayUtc(raw?: string): { from: Date; to: Date; iso: string } {
  let base: Date;
  if (raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new BadRequestException("date must be YYYY-MM-DD");
    }
    base = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(base.getTime())) throw new BadRequestException("date invalid");
  } else {
    const now = new Date();
    base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const from = base;
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const iso = from.toISOString().slice(0, 10);
  return { from, to, iso };
}
