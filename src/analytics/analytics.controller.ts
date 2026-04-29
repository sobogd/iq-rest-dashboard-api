import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { UAParser } from "ua-parser-js";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { getRequestCountry } from "../common/geo";

const COOKIE_NAME = "analytics_sid";
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const BOT_PATTERN = /bot|crawl|spider|scraper|headless|phantom|selenium|puppeteer|lighthouse/i;

const CONVERSION_FLAGS: Record<string, string> = {
  auth_signup: "wasRegistered",
  clicked_onboarding_continue: "namedRestaurant",
};

interface EventBody {
  event?: string;
  sessionId?: string;
  gclid?: string;
  keyword?: string;
  meta?: Record<string, unknown>;
}

// Apex-domain cookie so the landing site (iq-rest.com), the new SPA
// dashboard (dashboard.iq-rest.com), and the API itself
// (dashboard-api.iq-rest.com) all read the same analytics_sid value
// and merge into one Session row. ENV override kept for staging.
function getApexDomain(): string | undefined {
  return process.env.ANALYTICS_COOKIE_DOMAIN || ".iq-rest.com";
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

function ensureSessionCookie(req: Request, res: Response, hint?: string | null): string {
  const existing = readCookie(req, COOKIE_NAME);
  if (existing) return existing;
  const sessionId = hint && /^[0-9a-f-]{16,}$/i.test(hint) ? hint : randomUUID();
  res.cookie(COOKIE_NAME, sessionId, {
    domain: getApexDomain(),
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
    httpOnly: false,
  });
  return sessionId;
}

function extractIp(req: Request): string | null {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.ip ?? null;
}

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("event")
  @HttpCode(HttpStatus.OK)
  async event(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: EventBody,
  ) {
    if (!body.event) return { ok: false, error: "event required" };
    const sessionId = ensureSessionCookie(req, res, body.sessionId);

    const ua = req.headers["user-agent"] || null;
    const ip = extractIp(req);
    // Prefer Cloudflare/Vercel geo headers over the legacy geo_* cookies
    // (the dashboard SPA never sets them, but `cf-ipcountry` reaches us in prod).
    const cfCity = req.headers["cf-ipcity"];
    const country = getRequestCountry(req) || readCookie(req, "geo_country") || null;
    const city =
      (typeof cfCity === "string" && cfCity ? decodeURIComponent(cfCity) : null) ||
      readCookie(req, "geo_city") ||
      null;
    const landingPage = (body.meta?.page as string) || null;

    let browser: string | null = null;
    let device: string | null = null;
    if (ua) {
      const r = UAParser(ua);
      browser = r.browser.name || null;
      device = r.device.type || "desktop";
    }
    const isBot = ua ? BOT_PATTERN.test(ua) : false;

    const existing = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, country: true, city: true, landingPage: true, gclid: true, keyword: true },
    });

    if (existing) {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: {
          userAgent: ua,
          browser,
          device,
          ip,
          isBot,
          ...(existing.country === null && country ? { country } : {}),
          ...(existing.city === null && city ? { city } : {}),
          ...(existing.landingPage === null && landingPage ? { landingPage } : {}),
          ...(existing.gclid === null && body.gclid ? { gclid: body.gclid } : {}),
          ...(existing.keyword === null && body.keyword ? { keyword: body.keyword } : {}),
        },
      });
    } else {
      try {
        await this.prisma.session.create({
          data: {
            id: sessionId,
            country,
            city,
            landingPage,
            gclid: body.gclid || null,
            keyword: body.keyword || null,
            userAgent: ua,
            browser,
            device,
            ip,
            isBot,
          },
        });
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
          await this.prisma.session.update({
            where: { id: sessionId },
            data: { userAgent: ua, browser, device, ip, isBot },
          });
        } else {
          throw e;
        }
      }
    }

    const flagField = CONVERSION_FLAGS[body.event];
    if (flagField) {
      await this.prisma.session
        .update({ where: { id: sessionId }, data: { [flagField]: true } })
        .catch(() => undefined);
    }

    await this.prisma.analyticsEvent.create({
      data: { event: body.event, sessionId, ...(body.meta ? { meta: body.meta as never } : {}) },
    });

    return { success: true, sessionId };
  }

  @Post("heartbeat")
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { sessionId?: string }) {
    const sessionId = ensureSessionCookie(req, res, body.sessionId);
    await this.prisma.session
      .update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    return { ok: true };
  }

  @Post("link-session")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async linkSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { sessionId?: string },
  ) {
    const { userId, companyId } = (req as AuthedRequest).authUser;
    const sessionId = ensureSessionCookie(req, res, body.sessionId);

    const anonSession = await this.prisma.session.findUnique({ where: { id: sessionId } });
    const existingSession = await this.prisma.session.findFirst({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    if (existingSession && anonSession && existingSession.id !== sessionId) {
      await this.prisma.analyticsEvent.updateMany({
        where: { sessionId },
        data: { sessionId: existingSession.id },
      });
      await this.prisma.session.update({
        where: { id: existingSession.id },
        data: {
          country: existingSession.country ?? anonSession.country,
          gclid: existingSession.gclid ?? anonSession.gclid,
          keyword: existingSession.keyword ?? anonSession.keyword,
          userAgent: anonSession.userAgent ?? existingSession.userAgent,
          browser: anonSession.browser ?? existingSession.browser,
          device: anonSession.device ?? existingSession.device,
          ip: anonSession.ip ?? existingSession.ip,
          companyId: existingSession.companyId ?? companyId,
          wasRegistered: existingSession.wasRegistered || anonSession.wasRegistered || true,
          namedRestaurant: existingSession.namedRestaurant || anonSession.namedRestaurant,
          selectedType: existingSession.selectedType || anonSession.selectedType,
          modifiedMenu: existingSession.modifiedMenu || anonSession.modifiedMenu,
          modifiedContacts: existingSession.modifiedContacts || anonSession.modifiedContacts,
          modifiedDesign: existingSession.modifiedDesign || anonSession.modifiedDesign,
          reached50Views: existingSession.reached50Views || anonSession.reached50Views,
          paidSubscription: existingSession.paidSubscription || anonSession.paidSubscription,
        },
      });
      await this.prisma.session.delete({ where: { id: sessionId } });
      return { sessionId: existingSession.id };
    }

    if (anonSession) {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { userId, companyId, wasRegistered: true },
      });
      return { sessionId };
    }

    await this.prisma.session.create({
      data: { id: sessionId, userId, companyId, wasRegistered: true },
    });
    return { sessionId };
  }
}
