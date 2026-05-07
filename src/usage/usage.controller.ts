import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import { Throttle, seconds, minutes } from "@nestjs/throttler";
import type { Request } from "express";
import { UAParser } from "ua-parser-js";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../prisma/prisma.service";

const EVENT_REGEX = /^[a-z0-9_]{1,64}$/;
const GCLID_REGEX = /^[A-Za-z0-9_-]{1,256}$/;
const COUNTRY_REGEX = /^[A-Z]{2}$/;
const SESSION_COOKIE = "iqr_session";
const EMAIL_COOKIE = "iqr_email";

// support@iq-rest.com — internal admin company. Skip recording events from
// this account so support browsing dashboards/menus does not pollute metrics.
const ADMIN_COMPANY_IDS = new Set(["cmi5yzq5v0000vx0hbjmbks82"]);

function readCookie(req: Request, name: string): string | undefined {
  const fromParser = (req.cookies as Record<string, string | undefined> | undefined)?.[name];
  if (fromParser) return fromParser;
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

function headerStr(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (typeof v === "string" && v.length) return v;
  return null;
}

function decodeCity(raw: string | null): string | null {
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function classifyDevice(uaString: string | null): { device: string | null; platform: string | null } {
  if (!uaString) return { device: null, platform: null };
  try {
    const parser = new UAParser(uaString);
    const dev = parser.getDevice().type; // "mobile" | "tablet" | "console" | "smarttv" | "wearable" | "embedded" | undefined
    const os = (parser.getOS().name || "").toLowerCase();
    const device = dev === "mobile" || dev === "tablet" ? dev : "desktop";
    let platform: string | null = "other";
    if (os.includes("ios")) platform = "ios";
    else if (os.includes("android")) platform = "android";
    else if (os.includes("windows")) platform = "windows";
    else if (os.includes("mac") || os.includes("os x")) platform = "macos";
    else if (os.includes("linux") || os.includes("ubuntu") || os.includes("fedora") || os.includes("debian")) platform = "linux";
    return { device, platform };
  } catch {
    return { device: null, platform: null };
  }
}

function clampOccurredAt(raw: number | undefined): Date {
  const now = Date.now();
  if (typeof raw !== "number" || !Number.isFinite(raw)) return new Date(now);
  // Clamp to ±5 min to ignore wildly off client clocks while still preserving
  // sub-second source order for normal clients.
  const drift = Math.abs(now - raw);
  if (drift > 5 * 60 * 1000) return new Date(now);
  return new Date(raw);
}

interface UsageEventBody {
  event?: string;
  occurredAt?: number;
  gclid?: string;
  country?: string;     // SSR can forward user's geo cookie (nginx clobbers cf-* upstream)
  region?: string;
  userAgent?: string;   // SSR can forward user's UA (the API sees the SSR's UA otherwise)
}

@Controller("usage")
export class UsageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  @Throttle({
    burst: { ttl: seconds(1), limit: 30 },
    sustained: { ttl: minutes(1), limit: 1500 },
  })
  @Post("event")
  @HttpCode(HttpStatus.NO_CONTENT)
  async event(@Req() req: Request, @Body() body: UsageEventBody) {
    if (!body.event || !EVENT_REGEX.test(body.event)) {
      throw new BadRequestException("event invalid");
    }

    const gclid = body.gclid && GCLID_REGEX.test(body.gclid) ? body.gclid : null;

    // Geo: prefer body override (SSR forwards user's geo cookie because
    // intermediate nginx clobbers cf-* upstream), fall back to CF headers.
    const bodyCountry = body.country && COUNTRY_REGEX.test(body.country) ? body.country : null;
    const bodyRegion = body.region && body.region.length <= 100 ? body.region : null;
    const country = bodyCountry || headerStr(req, "cf-ipcountry") || "XX";
    const region = bodyRegion || decodeCity(headerStr(req, "cf-region")) || "";

    // Device + platform parsed from UA. SSR forwards the user's UA explicitly;
    // direct browser requests use the request's own UA header.
    const uaString = body.userAgent || headerStr(req, "user-agent");
    const { device, platform } = classifyDevice(uaString);

    // companyId only for authenticated users; quietly skip if cookies absent
    let companyId: string | null = null;
    const sessionCookie = readCookie(req, SESSION_COOKIE);
    const emailCookie = readCookie(req, EMAIL_COOKIE);
    if (sessionCookie && emailCookie) {
      try {
        const user = await this.auth.resolveSession(sessionCookie, emailCookie, {});
        companyId = user.companyId;
      } catch {
        // Invalid session — proceed anonymously
      }
    }

    if (companyId && ADMIN_COMPANY_IDS.has(companyId)) return;

    await this.prisma.usageEvent.create({
      data: {
        at: clampOccurredAt(body.occurredAt),
        event: body.event,
        country,
        region,
        device,
        platform,
        gclid,
        companyId,
      },
    });
  }
}
