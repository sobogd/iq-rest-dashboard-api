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
    if (period === "today") {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else {
      const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
      startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }

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
