import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

/** Attributes anonymous pre-login activity to the user/restaurant that later
 *  logged in from the same device fingerprint. Fingerprint = ip + device +
 *  platform + country + region; events of a fingerprint split into islands on
 *  >3-day gaps; an island with exactly one identity stamps it onto its
 *  anonymous events (stitchedUserId / stitchedRestaurantId). */
@Injectable()
export class UsageStitchService {
  private readonly logger = new Logger(UsageStitchService.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduled(): Promise<void> {
    const r = await this.stitch();
    if (!r.skipped) this.logger.log(`stitch: ${r.stitched} events, ${r.islands} islands`);
  }

  async stitch(): Promise<{ ok: boolean; stitched: number; islands: number; skipped?: boolean }> {
    if (this.running) return { ok: true, stitched: 0, islands: 0, skipped: true };
    this.running = true;
    try {
      const GAP_MS = 3 * 24 * 60 * 60 * 1000;
      // Only the last 7 days are (re)stitched: bounds memory/CPU and matches the
      // CAPI auto-send window. Older events keep the stitching computed when they
      // were fresh — so clearing must be scoped to this window too (see below).
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const rus = await this.prisma.restaurantUser.findMany({
        orderBy: { addedAt: "asc" },
        select: { userId: true, restaurantId: true },
      });
      const userRest = new Map<string, string>();
      for (const r of rus) if (!userRest.has(r.userId)) userRest.set(r.userId, r.restaurantId);

      const evs = await this.prisma.usageEvent.findMany({
        where: { at: { gte: since } },
        select: {
          id: true, at: true, ip: true, region: true, device: true,
          platform: true, country: true, userId: true, restaurantId: true,
        },
      });

      const fp = (e: { ip: string | null; region: string; country: string; device: string | null; platform: string | null }) =>
        `${e.ip ?? e.region ?? ""}|${e.country}|${e.device ?? ""}|${e.platform ?? ""}`;
      const groups = new Map<string, typeof evs>();
      for (const e of evs) {
        const k = fp(e);
        const arr = groups.get(k);
        if (arr) arr.push(e);
        else groups.set(k, [e]);
      }

      const assignments: Array<{ id: string; rid: string | null; uid: string | null }> = [];
      for (const list of groups.values()) {
        list.sort((a, b) => a.at.getTime() - b.at.getTime());
        let island: typeof evs = [];
        const flush = () => {
          if (island.length === 0) return;
          const rids = new Set<string>();
          const uids = new Set<string>();
          const effR = new Set<string>();
          for (const e of island) {
            if (e.restaurantId) { rids.add(e.restaurantId); effR.add(e.restaurantId); }
            if (e.userId) { uids.add(e.userId); const r = userRest.get(e.userId); if (r) effR.add(r); }
          }
          const identified = rids.size > 0 || uids.size > 0;
          const ambiguous = effR.size > 1 || uids.size > 1;
          if (identified && !ambiguous) {
            const rid = rids.size ? [...rids][0] : null;
            const uid = uids.size ? [...uids][0] : null;
            for (const e of island) {
              if (!e.restaurantId && !e.userId) assignments.push({ id: e.id, rid, uid });
            }
          }
          island = [];
        };
        let prev: number | null = null;
        for (const e of list) {
          if (prev !== null && e.at.getTime() - prev > GAP_MS) flush();
          island.push(e);
          prev = e.at.getTime();
        }
        flush();
      }

      const byKey = new Map<string, { rid: string | null; uid: string | null; ids: string[] }>();
      for (const a of assignments) {
        const k = `${a.rid}|${a.uid}`;
        const g = byKey.get(k);
        if (g) g.ids.push(a.id);
        else byKey.set(k, { rid: a.rid, uid: a.uid, ids: [a.id] });
      }

      // Clear + rewrite atomically so the CAPI cron / admin list never observe a
      // half-cleared state. Clearing is scoped to the same 7-day window we
      // recompute — older stitched events keep their values.
      await this.prisma.$transaction([
        this.prisma.usageEvent.updateMany({
          where: {
            at: { gte: since },
            OR: [{ stitchedRestaurantId: { not: null } }, { stitchedUserId: { not: null } }],
          },
          data: { stitchedRestaurantId: null, stitchedUserId: null },
        }),
        ...Array.from(byKey.values()).map(({ rid, uid, ids }) =>
          this.prisma.usageEvent.updateMany({
            where: { id: { in: ids } },
            data: { stitchedRestaurantId: rid, stitchedUserId: uid },
          }),
        ),
      ]);
      return { ok: true, stitched: assignments.length, islands: byKey.size };
    } finally {
      this.running = false;
    }
  }
}
