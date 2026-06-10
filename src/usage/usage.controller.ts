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
// Paid click ids — legacy dedicated names AND the new unified l_param_ names.
// Both carry a raw, case-sensitive id (with . and -) up to 512 chars, so they
// need a permissive regex separate from the generic EVENT_REGEX.
const GCLID_EVENT_REGEX = /^l_gclid_[A-Za-z0-9_-]{1,256}$/;
const FBCLID_EVENT_REGEX = /^l_fbclid_[A-Za-z0-9_.-]{1,512}$/;
const GCLID_PARAM_REGEX = /^l_param_gclid__[A-Za-z0-9_-]{1,256}$/;
const FBCLID_PARAM_REGEX = /^l_param_fbclid__[A-Za-z0-9_.-]{1,512}$/;
const REFERRER_HOST_REGEX =
  /(?:^|\.)(google|bing|yandex|duckduckgo|yahoo|baidu|ecosia|qwant|startpage|mojeek|brave)\.[a-z.]+$/i;
const SESSION_COOKIE = "iqr_session";
const EMAIL_COOKIE = "iqr_email";

// support@iq-rest.com — internal admin user. Skip recording events from
// this account so support browsing dashboards/menus does not pollute metrics.
const ADMIN_USER_IDS = new Set(["cmi5yzq780001vx0hiz2ti7fo"]);

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
    // `l_gclid_<ID>` / `l_fbclid_<ID>` events arrive from paid ad landings —
    // store name as-is, bypass bot filtering so every paid click is recorded
    // regardless of UA.
    const event = rawEvent;
    const isGoogleAds = GCLID_EVENT_REGEX.test(rawEvent) || GCLID_PARAM_REGEX.test(rawEvent);
    const isFacebookAds = FBCLID_EVENT_REGEX.test(rawEvent) || FBCLID_PARAM_REGEX.test(rawEvent);
    const isPaidAds = isGoogleAds || isFacebookAds;

    if (!isPaidAds && !EVENT_REGEX.test(rawEvent)) {
      throw new BadRequestException("event invalid");
    }

    const ua = headerStr(req, "user-agent");

    if (!isPaidAds && detectBot(ua)) return;

    const { device, platform } = classifyDevice(ua);

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

    let userId: string | null = null;
    const sessionCookie = readCookie(req, SESSION_COOKIE);
    const emailCookie = readCookie(req, EMAIL_COOKIE);
    if (sessionCookie && emailCookie) {
      try {
        const user = await this.auth.resolveSession(sessionCookie, emailCookie, {});
        userId = user.userId;
      } catch {
        // Invalid session — record as anonymous.
      }
    }

    if (userId && ADMIN_USER_IDS.has(userId)) return;

    // Per-restaurant analytics: capture the active restaurant from the
    // dashboard cookie so admin "by restaurant" filters work directly.
    // Anonymous events leave both userId and restaurantId null.
    const ACTIVE_RESTAURANT_COOKIE = "iqr_active_restaurant_id";
    let restaurantId = readCookie(req, ACTIVE_RESTAURANT_COOKIE) ?? null;

    // A dashboard action ALWAYS belongs to a venue, but the active-restaurant
    // cookie isn't set until the user first switches/creates a restaurant — so
    // a fresh single-restaurant or demo user's early dash_* events would land
    // with restaurantId null. Stamp the user's first restaurant in that case so
    // per-restaurant analytics + the session detail show the right venue. Only
    // for dash_* (landing l_* events legitimately carry no restaurant).
    if (!restaurantId && userId && event.startsWith("dash_")) {
      const ru = await this.prisma.restaurantUser.findFirst({
        where: { userId },
        orderBy: { addedAt: "asc" },
        select: { restaurantId: true },
      });
      restaurantId = ru?.restaurantId ?? null;
    }

    await this.prisma.usageEvent.create({
      data: {
        at: new Date(),
        event,
        country,
        region,
        device,
        platform,
        gclid: null,
        is_google_ads: isGoogleAds,
        is_facebook_ads: isFacebookAds,
        is_search: isSearch,
        userId,
        restaurantId,
        ip,
      },
    });
  }
}
