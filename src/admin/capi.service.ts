import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

/** Match data Meta uses to attribute a CAPI event to a person. All cookieless:
 *  fbc comes from the fbclid URL param, em/external_id are hashed identifiers. */
export interface CapiMatch {
  email?: string | null;
  userId?: string | null;
}

/** SHA-256 hex of a normalised value, as Meta requires for em/external_id. */
function hashField(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export type CapiEventName =
  | "ViewContent"
  | "InitiateCheckout"
  | "CompleteRegistration"
  | "Subscribe";

export interface CapiSendResult {
  ok: boolean;
  response: unknown;
}

/** One session's latest Facebook click + the funnel milestones it reached. */
interface FbSessionRow {
  fbclid: string;
  fb_at: Date;
  user_id: string | null; // effective user reached in the session (for em/external_id)
  has_content: boolean; // pricing page OR demo
  has_onb: boolean; // any onboarding step
  has_registered: boolean; // verify_success OR any dashboard event
}

@Injectable()
export class CapiService {
  private readonly logger = new Logger(CapiService.name);
  private autoRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Low-level Meta CAPI send. Always journals the attempt in CapiSend. Does
   *  NOT dedup — callers decide (manual send 409s, the cron skips). `match`
   *  carries cookieless identifiers (hashed email + external_id) that lift the
   *  Event Match Quality far above fbc-only. */
  async send(
    fbclid: string,
    eventName: string,
    clickMs?: number,
    match?: CapiMatch,
  ): Promise<CapiSendResult> {
    const token = this.config.get<string>("FB_ADS_TOKEN");
    const pixelId = this.config.get<string>("FB_ADS_PIXEL_ID");
    if (!token || !pixelId) {
      throw new Error("FB_ADS_TOKEN / FB_ADS_PIXEL_ID not configured");
    }

    const clickTs = typeof clickMs === "number" && clickMs > 0 ? clickMs : Date.now();
    const fbc = `fb.1.${clickTs}.${fbclid}`;
    const eventTime = Math.floor(Date.now() / 1000);

    const userData: Record<string, unknown> = { fbc };
    if (match?.email) userData.em = [hashField(match.email)];
    if (match?.userId) userData.external_id = [hashField(match.userId)];

    // Stable per-(fbclid,event) id so Meta dedups our own retries and any
    // future browser pixel that mirrors the same conversion.
    const eventId = createHash("sha256").update(`${fbclid}:${eventName}`).digest("hex");
    const sourceUrl = (this.config.get<string>("LANDING_URL") || "https://iq-rest.com").replace(/\/$/, "") + "/";

    let ok = false;
    let json: unknown = {};
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: [
              {
                event_name: eventName,
                event_time: eventTime,
                event_id: eventId,
                action_source: "website",
                event_source_url: sourceUrl,
                user_data: userData,
              },
            ],
          }),
        },
      );
      ok = res.ok;
      json = await res.json().catch(() => ({}));
    } catch (e) {
      await this.prisma.capiSend.create({
        data: { fbclid, eventName, status: "error", response: { error: String(e) } },
      });
      throw e;
    }

    await this.prisma.capiSend.create({
      data: { fbclid, eventName, status: ok ? "success" : "error", response: json as Prisma.InputJsonValue },
    });
    return { ok, response: json };
  }

  /** Every 15 minutes: find Facebook-click sessions over the last 7 days, work
   *  out which CAPI milestones they reached, and send the ones not yet
   *  successfully sent for that fbclid. The capi_sends journal is the dedup
   *  source of truth, so re-runs never double-send. The 7-day window must cover
   *  the click→milestone lag (a click can register days later, and the stitch
   *  cron backfills old events) — it is NOT a "recent activity" window. */
  @Cron("*/15 * * * *")
  async scheduledAutoSend(): Promise<void> {
    if (this.autoRunning) return;
    if (!this.config.get<string>("FB_ADS_TOKEN") || !this.config.get<string>("FB_ADS_PIXEL_ID")) return;
    this.autoRunning = true;
    try {
      await this.autoSend();
    } catch (e) {
      this.logger.error(`CAPI auto-send failed: ${String(e)}`);
    } finally {
      this.autoRunning = false;
    }
  }

  async autoSend(): Promise<{ sent: number; skipped: number }> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Group events into sessions (same effective-restaurant / anon ip key as the
    // admin session list) and, per session, capture the newest fbclid plus the
    // funnel milestones reached. Sessions without a fbclid can't be attributed.
    const rows = await this.prisma.$queryRaw<FbSessionRow[]>(Prisma.sql`
      WITH ev AS (
        SELECT ue.*,
               COALESCE(ue."manualRestaurantId", ue."restaurantId", ue."stitchedRestaurantId", ru."restaurantId") AS eff_rid
        FROM usage_events ue
        LEFT JOIN LATERAL (
          SELECT "restaurantId" FROM restaurant_users
          WHERE "userId" = COALESCE(ue."userId", ue."stitchedUserId") ORDER BY "addedAt" ASC LIMIT 1
        ) ru ON COALESCE(ue."userId", ue."stitchedUserId") IS NOT NULL
        WHERE ue.at >= ${since}
      ),
      grouped AS (
        SELECT
          (array_agg(event ORDER BY at DESC) FILTER (WHERE event LIKE 'l_fbclid_%'))[1] AS last_fbclid_event,
          MAX(at) FILTER (WHERE event LIKE 'l_fbclid_%') AS fb_at,
          (array_agg(COALESCE("userId", "stitchedUserId") ORDER BY at DESC) FILTER (WHERE COALESCE("userId", "stitchedUserId") IS NOT NULL))[1] AS user_id,
          bool_or(event = 'l_page_pricing' OR event LIKE 'l_demo%') AS has_content,
          bool_or(event LIKE '%onb%') AS has_onb,
          bool_or(event = 'l_onb_verify_success' OR event LIKE 'dash\\_%') AS has_registered
        FROM ev
        GROUP BY eff_rid, (CASE WHEN eff_rid IS NULL THEN COALESCE(ip, region) END)
      )
      SELECT
        regexp_replace(last_fbclid_event, '^l_fbclid_', '') AS fbclid,
        fb_at,
        user_id,
        has_content,
        has_onb,
        has_registered
      FROM grouped
      WHERE last_fbclid_event IS NOT NULL
    `);

    if (rows.length === 0) return { sent: 0, skipped: 0 };

    // Build the set of (fbclid → events to ensure). Full ladder: every reached
    // milestone. ViewContent ⊂ content/demo; InitiateCheckout ⊂ onboarding;
    // CompleteRegistration ⊂ verify_success or any dashboard activity.
    const wanted = new Map<string, { events: Set<CapiEventName>; clickMs: number; userId: string | null }>();
    for (const r of rows) {
      if (!r.fbclid) continue;
      const events = new Set<CapiEventName>();
      if (r.has_content) events.add("ViewContent");
      if (r.has_onb) events.add("InitiateCheckout");
      if (r.has_registered) events.add("CompleteRegistration");
      if (events.size === 0) continue;
      const clickMs = r.fb_at ? r.fb_at.getTime() : Date.now();
      const prev = wanted.get(r.fbclid);
      if (prev) {
        for (const e of events) prev.events.add(e);
        prev.clickMs = Math.max(prev.clickMs, clickMs);
        if (!prev.userId && r.user_id) prev.userId = r.user_id;
      } else {
        wanted.set(r.fbclid, { events, clickMs, userId: r.user_id });
      }
    }
    if (wanted.size === 0) return { sent: 0, skipped: 0 };

    // Resolve emails for the userIds we found, to enrich the match (cookieless).
    const userIds = Array.from(new Set(Array.from(wanted.values()).map((w) => w.userId).filter((v): v is string => !!v)));
    const emailById = new Map<string, string>();
    const demoIds = new Set<string>();
    if (userIds.length > 0) {
      const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, isDemo: true } });
      for (const u of users) {
        const isDemo = u.isDemo || u.email === "demo@iq-rest.com" || (!!u.email && u.email.startsWith("demo+"));
        if (isDemo) {
          // Demo = engagement only, never a registration. Mark so we drop its
          // CompleteRegistration below; a demo->real claim flips isDemo and the
          // next cron run then sends the registration for the real email.
          demoIds.add(u.id);
          continue;
        }
        if (u.email) emailById.set(u.id, u.email);
      }
    }

    // Journal lookup for these fbclids: a successful (fbclid,eventName) is never
    // resent; a pair that already failed MAX_ERRORS times is given up on (a
    // permanently-rejected event must not be retried forever every 15 minutes).
    const MAX_ERRORS = 3;
    const MAX_PER_RUN = 300;
    const fbclids = Array.from(wanted.keys());
    const journal = await this.prisma.capiSend.findMany({
      where: { fbclid: { in: fbclids }, status: { in: ["success", "error"] } },
      select: { fbclid: true, eventName: true, status: true },
    });
    const successSet = new Set<string>();
    const errorCount = new Map<string, number>();
    for (const j of journal) {
      const key = `${j.fbclid}|${j.eventName}`;
      if (j.status === "success") successSet.add(key);
      else errorCount.set(key, (errorCount.get(key) ?? 0) + 1);
    }

    let sent = 0;
    let skipped = 0;
    let capped = false;
    outer: for (const [fbclid, { events, clickMs, userId }] of wanted) {
      // Demo accounts reach the dashboard (dash_* events) but are NOT real
      // registrations — drop CompleteRegistration, keep the engagement events.
      if (userId && demoIds.has(userId)) events.delete("CompleteRegistration");
      const match: CapiMatch = { userId: userId && demoIds.has(userId) ? null : userId, email: userId ? emailById.get(userId) ?? null : null };
      for (const eventName of events) {
        const key = `${fbclid}|${eventName}`;
        if (successSet.has(key) || (errorCount.get(key) ?? 0) >= MAX_ERRORS) {
          skipped++;
          continue;
        }
        if (sent >= MAX_PER_RUN) {
          capped = true;
          break outer;
        }
        try {
          const r = await this.send(fbclid, eventName, clickMs, match);
          if (r.ok) sent++;
        } catch (e) {
          this.logger.warn(`CAPI auto-send ${eventName} for ${fbclid} failed: ${String(e)}`);
        }
      }
    }
    if (sent > 0 || capped) {
      this.logger.log(`CAPI auto-send: ${sent} sent, ${skipped} skipped${capped ? " (capped, more next run)" : ""}`);
    }
    return { sent, skipped };
  }
}
