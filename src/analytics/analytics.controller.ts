import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";

function densifyByDay(
  rows: { day: string; views: bigint; scans: bigint }[],
  start: Date,
  end: Date,
): { day: string; views: number; scans: number }[] {
  const map = new Map(rows.map((r) => [r.day, r]));
  const out: { day: string; views: number; scans: number }[] = [];
  // Iterate full UTC days touched by the [start, end) window so today (a
  // partial UTC day) is still rendered as the last bar.
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cursor < end) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;
    const row = map.get(key);
    out.push({ day: key, views: row ? Number(row.views) : 0, scans: row ? Number(row.scans) : 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Public-menu analytics: page_views + unique sessions for the authenticated
   *  user's company. Drives the /dashboard/analytics page. Periods accepted:
   *  today, 7d, 30d, 90d. */
  @Get("stats")
  @UseGuards(AuthGuard)
  async stats(@Req() req: Request, @Query("period") periodRaw = "7d") {
    const { companyId } = (req as AuthedRequest).authUser;
    const period = ["today", "7d", "30d", "90d"].includes(periodRaw) ? periodRaw : "7d";

    const now = new Date();
    let startDate: Date;
    let endDate: Date = now;
    let prevStartDate: Date;
    let prevEndDate: Date;
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (period === "today") {
      // Align to UTC midnight so the per-day bucketing query (TO_CHAR ... AT
      // TIME ZONE 'UTC') and the dense daily fill use the same day key.
      // Using local midnight rolls back to the previous UTC date for any
      // positive UTC offset (e.g. Spain CEST), which produced "yesterday"
      // labels for today's clicks.
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      endDate = new Date(startDate.getTime() + DAY_MS);
      prevEndDate = startDate;
      prevStartDate = new Date(startDate.getTime() - DAY_MS);
    } else {
      const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
      // Window: [today_utc_midnight - (days-1), tomorrow_utc_midnight) so the
      // dashboard and the admin list agree for the entire calendar day and
      // today is fully included.
      const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      endDate = new Date(todayUtc.getTime() + DAY_MS);
      startDate = new Date(endDate.getTime() - days * DAY_MS);
      prevEndDate = startDate;
      prevStartDate = new Date(startDate.getTime() - days * DAY_MS);
    }

    const [totalViews, uniqSessionsRows, byDayRaw, byDayPrevRaw, byLangRaw, byPageRaw] =
      await Promise.all([
        this.prisma.pageView.count({ where: { companyId, createdAt: { gte: startDate, lt: endDate } } }),
        this.prisma.pageView.groupBy({
          by: ["sessionId"],
          where: { companyId, createdAt: { gte: startDate, lt: endDate } },
        }),
        this.prisma.$queryRaw<{ day: string; views: bigint; scans: bigint }[]>`
          SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                 COUNT(*) AS views,
                 COUNT(DISTINCT "sessionId") AS scans
          FROM page_views
          WHERE "companyId" = ${companyId} AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
          GROUP BY day
          ORDER BY day ASC
        `,
        this.prisma.$queryRaw<{ day: string; views: bigint; scans: bigint }[]>`
          SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                 COUNT(*) AS views,
                 COUNT(DISTINCT "sessionId") AS scans
          FROM page_views
          WHERE "companyId" = ${companyId} AND "createdAt" >= ${prevStartDate} AND "createdAt" < ${prevEndDate}
          GROUP BY day
          ORDER BY day ASC
        `,
        this.prisma.$queryRaw<{ language: string; views: bigint; scans: bigint }[]>`
          SELECT language, COUNT(*) AS views, COUNT(DISTINCT "sessionId") AS scans
          FROM page_views
          WHERE "companyId" = ${companyId} AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
          GROUP BY language
          ORDER BY views DESC
        `,
        this.prisma.$queryRaw<{ page: string; views: bigint; sessions: bigint }[]>`
          SELECT page, COUNT(*) AS views, COUNT(DISTINCT "sessionId") AS sessions
          FROM page_views
          WHERE "companyId" = ${companyId} AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
          GROUP BY page
          ORDER BY views DESC
        `,
      ]);

    const totalScans = uniqSessionsRows.length;

    return {
      period,
      totalViews,
      totalScans,
      byDay: densifyByDay(byDayRaw, startDate, endDate),
      byDayPrev: densifyByDay(byDayPrevRaw, prevStartDate, prevEndDate),
      byLanguage: byLangRaw.map((l) => ({ language: l.language, views: Number(l.views), scans: Number(l.scans) })),
      byPage: byPageRaw.map((p) => ({ page: p.page, views: Number(p.views), sessions: Number(p.sessions) })),
    };
  }
}
