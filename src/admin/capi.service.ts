import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

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
   *  NOT dedup — callers decide (manual send 409s, the cron skips). */
  async send(fbclid: string, eventName: string, clickMs?: number): Promise<CapiSendResult> {
    const token = this.config.get<string>("FB_ADS_TOKEN");
    const pixelId = this.config.get<string>("FB_ADS_PIXEL_ID");
    if (!token || !pixelId) {
      throw new Error("FB_ADS_TOKEN / FB_ADS_PIXEL_ID not configured");
    }

    const clickTs = typeof clickMs === "number" && clickMs > 0 ? clickMs : Date.now();
    const fbc = `fb.1.${clickTs}.${fbclid}`;
    const eventTime = Math.floor(Date.now() / 1000);

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
                action_source: "website",
                event_source_url: "https://soqrmenu.com/",
                user_data: { fbc },
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

  /** Every 5 minutes: find Facebook-click sessions over the last 7 days, work
   *  out which CAPI milestones they reached, and send the ones not yet
   *  successfully sent for that fbclid. The capi_sends journal is the dedup
   *  source of truth, so re-runs never double-send. */
  @Cron(CronExpression.EVERY_5_MINUTES)
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
          bool_or(event = 'l_page_pricing' OR event LIKE '%demo%') AS has_content,
          bool_or(event LIKE '%onb%') AS has_onb,
          bool_or(event = 'l_onb_verify_success' OR event LIKE 'dash\\_%') AS has_registered
        FROM ev
        GROUP BY eff_rid, (CASE WHEN eff_rid IS NULL THEN COALESCE(ip, region) END)
      )
      SELECT
        regexp_replace(last_fbclid_event, '^l_fbclid_', '') AS fbclid,
        fb_at,
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
    const wanted = new Map<string, { events: Set<CapiEventName>; clickMs: number }>();
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
      } else {
        wanted.set(r.fbclid, { events, clickMs });
      }
    }
    if (wanted.size === 0) return { sent: 0, skipped: 0 };

    // Which (fbclid, eventName) already succeeded? One lookup over the journal.
    const fbclids = Array.from(wanted.keys());
    const already = await this.prisma.capiSend.findMany({
      where: { fbclid: { in: fbclids }, status: "success" },
      select: { fbclid: true, eventName: true },
    });
    const alreadySet = new Set(already.map((a) => `${a.fbclid}|${a.eventName}`));

    let sent = 0;
    let skipped = 0;
    for (const [fbclid, { events, clickMs }] of wanted) {
      for (const eventName of events) {
        if (alreadySet.has(`${fbclid}|${eventName}`)) {
          skipped++;
          continue;
        }
        try {
          const r = await this.send(fbclid, eventName, clickMs);
          if (r.ok) sent++;
        } catch (e) {
          this.logger.warn(`CAPI auto-send ${eventName} for ${fbclid} failed: ${String(e)}`);
        }
      }
    }
    if (sent > 0) this.logger.log(`CAPI auto-send: ${sent} sent, ${skipped} already present`);
    return { sent, skipped };
  }
}
