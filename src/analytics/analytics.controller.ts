import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle, seconds, minutes } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

const COOKIE_NAME = "analytics_sid";
const DISABLED_COOKIE = "analytics_disabled";
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const EVENT_REGEX = /^[a-z0-9_]{1,64}$/;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = (process.env.ADMIN_EMAIL_DOMAIN || "iq-rest.com").toLowerCase();
  return email.toLowerCase().endsWith("@" + domain);
}
// Accept UUID v4 from this controller and cuid from prior IDs (admin reuse).
// cuid: starts with "c", 25 chars total, [a-z0-9]. UUID: standard form.
const SID_REGEX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{24})$/i;

interface EventBody {
  event?: string;
  occurredAt?: string;
  gclid?: string;
}

const GCLID_REGEX = /^[A-Za-z0-9_-]{1,256}$/;

function getApexDomain(): string | undefined {
  return process.env.ANALYTICS_COOKIE_DOMAIN || undefined;
}

function cookieOptions() {
  return {
    domain: getApexDomain(),
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
    sameSite: "lax" as const,
    secure: process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
    httpOnly: false,
  };
}

function readCookie(req: Request, name: string): string | undefined {
  const fromParser = (req.cookies as Record<string, string | undefined> | undefined)?.[name];
  if (fromParser) return fromParser;
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

function ensureSessionCookie(req: Request, res: Response): string {
  const existing = readCookie(req, COOKIE_NAME);
  if (existing && SID_REGEX.test(existing)) return existing;
  const sessionId = randomUUID();
  res.cookie(COOKIE_NAME, sessionId, cookieOptions());
  return sessionId;
}

function extractIp(req: Request): string | null {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.ip ?? null;
}

function headerStr(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (typeof v === "string" && v.length) return v;
  return null;
}

function decodeCity(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseOccurredAt(raw: string | undefined): Date {
  if (!raw) throw new BadRequestException("occurredAt required");
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException("occurredAt invalid");
  const now = Date.now();
  if (d.getTime() > now + FUTURE_TOLERANCE_MS) {
    throw new BadRequestException("occurredAt too far in future");
  }
  if (d.getTime() < now - PAST_TOLERANCE_MS) {
    throw new BadRequestException("occurredAt too far in past");
  }
  return d;
}

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  // 30 events/sec burst (covers 10-20 events/sec sustained per active user)
  // and 1500/min sustained per IP. Anonymous endpoint, no auth.
  @Throttle({
    burst: { ttl: seconds(1), limit: 30 },
    sustained: { ttl: minutes(1), limit: 1500 },
  })
  @Post("event")
  @HttpCode(HttpStatus.OK)
  async event(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: EventBody,
  ) {
    if (!body.event || !EVENT_REGEX.test(body.event)) {
      throw new BadRequestException("event invalid");
    }
    // Admin browsers carry analytics_disabled=1 set on /identify. Skip writes
    // entirely so admin activity never pollutes session/event aggregates.
    if (readCookie(req, DISABLED_COOKIE) === "1") {
      return { ok: true, disabled: true };
    }
    const occurredAt = parseOccurredAt(body.occurredAt);
    const sessionId = ensureSessionCookie(req, res);
    const ip = extractIp(req);
    const ua = req.headers["user-agent"] || null;
    const country = headerStr(req, "cf-ipcountry");
    const region = decodeCity(headerStr(req, "cf-region"));
    const city = decodeCity(headerStr(req, "cf-ipcity"));
    const gclid = body.gclid && GCLID_REGEX.test(body.gclid) ? body.gclid : null;

    // Read existing row to know which first-touch fields are still NULL — we
    // backfill those on update without overwriting fields already populated.
    const existing = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { country: true, region: true, city: true, gclid: true },
    });

    if (existing) {
      const patch: { country?: string; region?: string; city?: string; gclid?: string } = {};
      if (!existing.country && country) patch.country = country;
      if (!existing.region && region) patch.region = region;
      if (!existing.city && city) patch.city = city;
      if (!existing.gclid && gclid) patch.gclid = gclid;
      if (Object.keys(patch).length) {
        await this.prisma.session.update({ where: { id: sessionId }, data: patch });
      }
    } else {
      await this.prisma.session.create({
        data: { id: sessionId, ip, userAgent: ua, country, region, city, gclid },
      });
    }

    await this.prisma.analyticsEvent.create({
      data: { sessionId, event: body.event, occurredAt },
    });

    return { ok: true };
  }

  // Cookieless aggregate counter — no sid/IP/UA persisted. Lawful without consent.
  // Frontend calls this on every track() regardless of consent state.
  @Throttle({
    burst: { ttl: seconds(1), limit: 30 },
    sustained: { ttl: minutes(1), limit: 1500 },
  })
  @Post("pulse")
  @HttpCode(HttpStatus.NO_CONTENT)
  async pulse(
    @Req() req: Request,
    @Body() body: { event?: string; gclid?: string; country?: string; region?: string; occurredAt?: number },
  ) {
    if (!body.event || !EVENT_REGEX.test(body.event)) {
      throw new BadRequestException("event invalid");
    }
    if (readCookie(req, DISABLED_COOKIE) === "1") return;
    // Allow body country/region override for server-to-server calls (Next.js SSR
    // forwarding user's geo from middleware-set cookies, since intermediate nginx
    // would otherwise clobber the cf-* headers with the proxy's own geo).
    const bodyCountry = body.country && /^[A-Z]{2}$/.test(body.country) ? body.country : null;
    const bodyRegion = body.region && body.region.length <= 100 ? body.region : null;
    const country = bodyCountry || headerStr(req, "cf-ipcountry") || "XX";
    const region = bodyRegion || decodeCity(headerStr(req, "cf-region")) || "";
    const gclid = body.gclid && GCLID_REGEX.test(body.gclid) ? body.gclid : null;
    // Client-sent UTC ms timestamp preserves source-order across racing fetch().
    // Fallback to server time if absent (back-compat with old clients).
    const at = typeof body.occurredAt === "number" && Number.isFinite(body.occurredAt)
      ? new Date(body.occurredAt)
      : new Date();
    await this.prisma.pulseEvent.create({
      data: { at, event: body.event, country, region, gclid },
    });
  }

  @Post("identify")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async identify(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { userId, companyId, email } = (req as AuthedRequest).authUser;
    const currentId = ensureSessionCookie(req, res);

    if (isAdminEmail(email)) {
      // Wipe whatever this browser produced so far + any other sessions
      // attached to this admin user, then plant analytics_disabled=1 on the
      // apex cookie so subsequent /event calls return without writes.
      await this.prisma.$transaction([
        this.prisma.analyticsEvent.deleteMany({ where: { sessionId: currentId } }),
        this.prisma.session.deleteMany({ where: { OR: [{ id: currentId }, { userId }] } }),
      ]);
      res.cookie(DISABLED_COOKIE, "1", cookieOptions());
      res.clearCookie(COOKIE_NAME, { domain: getApexDomain(), path: "/" });
      return { disabled: true };
    }

    const previous = await this.prisma.session.findFirst({
      where: { userId, NOT: { id: currentId } },
      orderBy: { createdAt: "asc" },
      select: { id: true, companyId: true },
    });

    if (previous) {
      await this.prisma.$transaction([
        this.prisma.analyticsEvent.updateMany({
          where: { sessionId: currentId },
          data: { sessionId: previous.id },
        }),
        this.prisma.session.deleteMany({ where: { id: currentId } }),
        this.prisma.session.update({
          where: { id: previous.id },
          data: { companyId: previous.companyId ?? companyId },
        }),
      ]);
      res.cookie(COOKIE_NAME, previous.id, cookieOptions());
      return { sessionId: previous.id };
    }

    await this.prisma.session.upsert({
      where: { id: currentId },
      create: { id: currentId, userId, companyId },
      update: { userId, companyId },
    });
    return { sessionId: currentId };
  }

  /** Public-menu analytics: views + unique sessions for the authenticated user's company.
   *  Drives the /dashboard/analytics page. Periods accepted: today, 7d, 30d, 90d. */
  @Get("stats")
  @UseGuards(AuthGuard)
  async stats(@Req() req: Request, @Query("period") periodRaw = "7d") {
    const { companyId } = (req as AuthedRequest).authUser;
    const period = ["today", "7d", "30d", "90d"].includes(periodRaw) ? periodRaw : "7d";

    const now = new Date();
    let startDate: Date;
    if (period === "today") {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else {
      const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
      startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }

    // Counts (single round-trip via Promise.all — read-only, no transaction needed).
    const [totalViews, uniqSessionsRows, byDayRaw, byLangRaw, byPageRaw, monthlyRows, company] =
      await Promise.all([
        this.prisma.pageView.count({ where: { companyId, createdAt: { gte: startDate } } }),
        this.prisma.pageView.groupBy({
          by: ["sessionId"],
          where: { companyId, createdAt: { gte: startDate } },
        }),
        this.prisma.$queryRaw<{ day: string; views: bigint; scans: bigint }[]>`
          SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                 COUNT(*) AS views,
                 COUNT(DISTINCT "sessionId") AS scans
          FROM page_views
          WHERE "companyId" = ${companyId} AND "createdAt" >= ${startDate}
          GROUP BY day
          ORDER BY day ASC
        `,
        this.prisma.$queryRaw<{ language: string; views: bigint; scans: bigint }[]>`
          SELECT language, COUNT(*) AS views, COUNT(DISTINCT "sessionId") AS scans
          FROM page_views
          WHERE "companyId" = ${companyId} AND "createdAt" >= ${startDate}
          GROUP BY language
          ORDER BY views DESC
        `,
        this.prisma.$queryRaw<{ page: string; views: bigint; sessions: bigint }[]>`
          SELECT page, COUNT(*) AS views, COUNT(DISTINCT "sessionId") AS sessions
          FROM page_views
          WHERE "companyId" = ${companyId} AND "createdAt" >= ${startDate}
          GROUP BY page
          ORDER BY views DESC
        `,
        this.prisma.pageView.groupBy({
          by: ["sessionId"],
          where: {
            companyId,
            createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) },
          },
        }),
        this.prisma.company.findUnique({
          where: { id: companyId },
          select: { plan: true, scanLimit: true },
        }),
      ]);

    const totalScans = uniqSessionsRows.length;
    const sessionIds = uniqSessionsRows.map((r) => r.sessionId);

    // Returning visitor count: sessions in the period that also had views before the period.
    const returning =
      sessionIds.length > 0
        ? await this.prisma.pageView.groupBy({
            by: ["sessionId"],
            where: {
              companyId,
              sessionId: { in: sessionIds },
              createdAt: { lt: startDate },
            },
          })
        : [];

    return {
      period,
      totalViews,
      totalScans,
      avgPagesPerSession: totalScans > 0 ? totalViews / totalScans : 0,
      returningScans: returning.length,
      byDay: byDayRaw.map((d) => ({ day: d.day, views: Number(d.views), scans: Number(d.scans) })),
      byLanguage: byLangRaw.map((l) => ({ language: l.language, views: Number(l.views), scans: Number(l.scans) })),
      byPage: byPageRaw.map((p) => ({ page: p.page, views: Number(p.views), sessions: Number(p.sessions) })),
      monthlyScans: monthlyRows.length,
      plan: company?.plan ?? null,
      scanLimit: company?.scanLimit ?? null,
    };
  }
}
