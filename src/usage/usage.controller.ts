import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { Throttle, seconds, minutes } from "@nestjs/throttler";
import type { Request } from "express";
import { UAParser } from "ua-parser-js";
import { isbot } from "isbot";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../prisma/prisma.service";

const EVENT_REGEX = /^[a-z0-9_]{1,64}$/;
const GCLID_PREFIX = "land_gclid_";
const GCLID_VALUE_REGEX = /^[A-Za-z0-9_-]{1,256}$/;
const REFERRER_HOST_REGEX =
  /(?:^|\.)(google|bing|yandex|duckduckgo|yahoo|baidu|ecosia|qwant|startpage|mojeek|brave)\.[a-z.]+$/i;
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

function decodeRegion(raw: string | null): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw).slice(0, 100);
  } catch {
    return raw.slice(0, 100);
  }
}

function anonymizeIp(raw: string | null): string | null {
  if (!raw) return null;
  const ip = raw.trim().split(",")[0]?.trim();
  if (!ip) return null;
  if (ip.includes(":")) {
    const parts = ip.split(":").filter((p) => p.length > 0);
    return parts.slice(0, 4).join(":") + "::";
  }
  const oct = ip.split(".");
  if (oct.length !== 4) return null;
  return `${oct[0]}.${oct[1]}.${oct[2]}.0`;
}

const EXTRA_BOT_UA_REGEX =
  /AdsBot|Google-InspectionTool|GoogleOther|APIs-Google|FeedFetcher-Google|Storebot-Google|GoogleProducer|ChromeOS-Default-Bot|HeadlessChrome|PhantomJS|Screaming Frog|Sitebulb|axios\/|node-fetch|got\/|http_request|httpclient|java\/|okhttp|libwww|lwp-trivial|HttpClient|Apache-HttpClient/i;

function detectBot(ua: string | null): boolean {
  if (!ua) return true;
  if (isbot(ua)) return true;
  if (EXTRA_BOT_UA_REGEX.test(ua)) return true;
  return false;
}

function classifyDevice(uaString: string | null): { device: string | null; platform: string | null } {
  if (!uaString) return { device: null, platform: null };
  try {
    const parser = new UAParser(uaString);
    const dev = parser.getDevice().type;
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

@Controller()
export class UsageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  @Throttle({
    burst: { ttl: seconds(1), limit: 10 },
    sustained: { ttl: minutes(1), limit: 200 },
  })
  @Post("track/:event")
  @HttpCode(HttpStatus.NO_CONTENT)
  async track(
    @Param("event") rawEvent: string,
    @Query("r") referrerHost: string | undefined,
    @Req() req: Request,
  ) {
    // Parse event name. `land_gclid_<GCLID>` is a special form: the gclid
    // value travels in the URL path so the server can split it off into the
    // dedicated `gclid` column without ever needing a request body.
    let event = rawEvent;
    let gclid: string | null = null;
    let gclidArrived = false;

    if (rawEvent.startsWith(GCLID_PREFIX)) {
      const candidate = rawEvent.slice(GCLID_PREFIX.length);
      if (!GCLID_VALUE_REGEX.test(candidate)) throw new BadRequestException("gclid invalid");
      gclid = candidate;
      event = "land_gclid";
      gclidArrived = true;
    } else if (!EVENT_REGEX.test(rawEvent)) {
      throw new BadRequestException("event invalid");
    }

    const ua = headerStr(req, "user-agent");
    const { device, platform } = classifyDevice(ua);
    const isBot = detectBot(ua);

    // Bot-vs-GoogleAds is a strict mutex: only non-bot arrivals from a Google
    // Ads click get the conversion-eligible is_google_ads flag. Bot gclids
    // remain in the row (useful for filtering ad fraud) but are excluded
    // from conversion uploads by `WHERE is_google_ads = true`.
    const isGoogleAds = gclidArrived && !isBot;

    // Referrer detection happens client-side: a JS fetch always sends the
    // current page URL as Referer, not the original document.referrer, so
    // the only way to know whether the user arrived from a search engine is
    // to have the client read `document.referrer` and forward its hostname.
    let isSearch = false;
    if (
      referrerHost &&
      referrerHost.length <= 253 &&
      REFERRER_HOST_REGEX.test(referrerHost)
    ) {
      isSearch = true;
    }

    const ip = anonymizeIp(
      headerStr(req, "cf-connecting-ip") || headerStr(req, "x-forwarded-for"),
    );
    const country = headerStr(req, "cf-ipcountry") || "XX";
    const region = decodeRegion(headerStr(req, "cf-region"));

    // Admin impersonation skip: an admin browsing as another user must not
    // pollute that user's metrics nor surface as anonymous traffic.
    if (
      readCookie(req, "iqr_admin_original_session") &&
      readCookie(req, "iqr_admin_original_email")
    ) {
      return;
    }

    let companyId: string | null = null;
    const sessionCookie = readCookie(req, SESSION_COOKIE);
    const emailCookie = readCookie(req, EMAIL_COOKIE);
    if (sessionCookie && emailCookie) {
      try {
        const user = await this.auth.resolveSession(sessionCookie, emailCookie, {});
        companyId = user.companyId;
      } catch {
        // Invalid session — record as anonymous.
      }
    }

    if (companyId && ADMIN_COMPANY_IDS.has(companyId)) return;

    await this.prisma.usageEvent.create({
      data: {
        at: new Date(),
        event,
        country,
        region,
        device,
        platform,
        gclid,
        is_google_ads: isGoogleAds,
        is_search: isSearch,
        is_bot: isBot,
        companyId,
        ip,
      },
    });
  }
}
