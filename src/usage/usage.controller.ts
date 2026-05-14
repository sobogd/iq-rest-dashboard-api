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
import { isbot } from "isbot";
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

/** Mirrors the middleware-side detector in soqrmenuweb/middleware.ts. Both
 *  write paths (SSR land_page_* and JS-fired land_*_section_show_*) must
 *  classify bots identically; otherwise AdsBot (which renders JS) flips
 *  is_bot=false on the JS rows while the SSR row says true. */
const EXTRA_BOT_UA_REGEX =
  /AdsBot|Google-InspectionTool|GoogleOther|APIs-Google|FeedFetcher-Google|Storebot-Google|GoogleProducer|ChromeOS-Default-Bot|HeadlessChrome|PhantomJS|Screaming Frog|Sitebulb|axios\/|node-fetch|got\/|http_request|httpclient|java\/|okhttp|libwww|lwp-trivial|HttpClient|Apache-HttpClient/i;

function detectBot(ua: string | null): boolean {
  if (!ua) return true;
  if (isbot(ua)) return true;
  if (EXTRA_BOT_UA_REGEX.test(ua)) return true;
  return false;
}

/** Mirrors classifyReferrer in soqrmenuweb/middleware.ts. Both write paths
 *  must agree so SSR rows and JS-fired rows from the same visit produce
 *  identical referrer_source values. Hostname-only — raw URL never stored. */
const OWN_HOST = "iq-rest.com";

function classifyReferrer(referer: string | null | undefined): string | null {
  if (!referer) return null;
  let host: string;
  let path: string;
  try {
    const u = new URL(referer);
    host = u.hostname.toLowerCase();
    path = u.pathname || "/";
  } catch {
    return null;
  }
  if (!host) return null;
  if (host === OWN_HOST || host.endsWith(`.${OWN_HOST}`)) return "internal";
  if (/^(www\.)?google\.[a-z.]{2,6}$/.test(host)) {
    if (path.startsWith("/search") || path.startsWith("/url") || path === "/") return "google_search";
    return "google_search";
  }
  if (host === "bing.com" || host.endsWith(".bing.com")) return "bing";
  if (/^(www\.)?yandex\.[a-z.]{2,6}$/.test(host) || host.endsWith(".yandex.ru") || host.endsWith(".yandex.com")) return "yandex";
  if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return "duckduckgo";
  if (host.endsWith("search.yahoo.com") || host === "yahoo.com" || host.endsWith(".yahoo.com")) return "yahoo";
  if (host === "baidu.com" || host.endsWith(".baidu.com")) return "other_search";
  if (host.endsWith("ecosia.org") || host.endsWith("qwant.com") || host.endsWith("startpage.com") || host.endsWith("mojeek.com") || host.endsWith("brave.com")) return "other_search";
  if (
    host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com") ||
    host === "instagram.com" || host.endsWith(".instagram.com") ||
    host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com") || host === "t.co" ||
    host === "linkedin.com" || host.endsWith(".linkedin.com") ||
    host === "tiktok.com" || host.endsWith(".tiktok.com") ||
    host === "reddit.com" || host.endsWith(".reddit.com") ||
    host === "pinterest.com" || host.endsWith(".pinterest.com") ||
    host === "t.me" || host === "telegram.org" || host.endsWith(".telegram.org") ||
    host.endsWith("whatsapp.com") || host.endsWith("youtube.com") || host === "youtu.be"
  ) return "social";
  return "other";
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

/** Always stamp with server time so JS-fired events and SSR rows live on a
 *  single monotonic clock. The body's `occurredAt` (client `Date.now()`) is
 *  ignored — clients with skewed system clocks were producing rows that
 *  sorted before / after the surrounding session by whole seconds, breaking
 *  the admin timeline's per-second ordering. Network latency from the
 *  client `track()` call to here is on the order of tens of milliseconds,
 *  which keeps the order on a single user's session intact while erasing
 *  the cross-client clock drift. */
function serverNow(): Date {
  return new Date();
}

interface UsageEventBody {
  event?: string;
  occurredAt?: number;
  gclid?: string;
  country?: string;     // SSR can forward user's geo cookie (nginx clobbers cf-* upstream)
  region?: string;
  userAgent?: string;   // SSR can forward user's UA (the API sees the SSR's UA otherwise)
  referrer?: string;    // browser sends document.referrer; classified server-side, raw URL not stored
  isGoogleAds?: boolean; // client persists this boolean in localStorage once a gclid is observed on the URL; subsequent JS-fired events flip it on so they're not misclassified as organic search
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
    const isBot = detectBot(uaString);
    // body.referrer is document.referrer captured by the browser at event
    // time — for first-page-load events that's the originating Google search
    // or social post. Fall back to the request Referer header for non-browser
    // callers, but it will usually be the page URL itself (not the search).
    const referrerSource = classifyReferrer(body.referrer || headerStr(req, "referer"));
    // Promote to true if the client supplies the flag *or* the legacy gclid
    // field is on this event. Never demote to false here — the SSR row may
    // have set the flag for the same visit and we don't want a later JS event
    // to clobber it.
    const isGoogleAds = body.isGoogleAds === true || !!gclid;

    // Anonymized client IP (last IPv4 octet zeroed, IPv6 truncated to /64)
    const ip = anonymizeIp(headerStr(req, "cf-connecting-ip") || headerStr(req, "x-forwarded-for"));

    // Skip events from admin impersonation — admin browsing as client must
    // not pollute target's metrics nor surface as anonymous traffic.
    if (
      readCookie(req, "iqr_admin_original_session") &&
      readCookie(req, "iqr_admin_original_email")
    ) {
      return;
    }

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
        at: serverNow(),
        event: body.event,
        country,
        region,
        device,
        platform,
        gclid,
        companyId,
        ip,
        is_bot: isBot,
        referrer_source: referrerSource,
        is_google_ads: isGoogleAds,
      },
    });
  }
}
