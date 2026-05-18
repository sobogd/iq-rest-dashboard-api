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
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cursor < end) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;
    const row = map.get(key);
    out.push({ day: key, views: row ? Number(row.views) : 0, scans: row ? Number(row.scans) : 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function densifyOrdersByDay(
  rows: { day: string; revenue: string | number; orders: bigint }[],
  start: Date,
  end: Date,
): { day: string; revenue: number; orders: number }[] {
  const map = new Map(rows.map((r) => [r.day, r]));
  const out: { day: string; revenue: number; orders: number }[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cursor < end) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;
    const row = map.get(key);
    out.push({
      day: key,
      revenue: row ? Number(row.revenue) : 0,
      orders: row ? Number(row.orders) : 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Parse a YYYY-MM period string and return the UTC half-open month window
 *  [start, end). Falls back to the current UTC month if the input is missing
 *  or malformed. Also returns the matching previous-month window for delta
 *  calculation. */
function monthWindow(periodRaw: string): {
  period: string;
  startDate: Date;
  endDate: Date;
  prevStartDate: Date;
  prevEndDate: Date;
} {
  const now = new Date();
  const match = /^(\d{4})-(\d{2})$/.exec(periodRaw);
  let year: number;
  let month0: number; // 0-indexed
  if (match) {
    year = Number(match[1]);
    month0 = Number(match[2]) - 1;
    if (month0 < 0 || month0 > 11) {
      year = now.getUTCFullYear();
      month0 = now.getUTCMonth();
    }
  } else {
    year = now.getUTCFullYear();
    month0 = now.getUTCMonth();
  }
  const startDate = new Date(Date.UTC(year, month0, 1));
  const endDate = new Date(Date.UTC(year, month0 + 1, 1));
  const prevStartDate = new Date(Date.UTC(year, month0 - 1, 1));
  const prevEndDate = startDate;
  const period = `${year}-${String(month0 + 1).padStart(2, "0")}`;
  return { period, startDate, endDate, prevStartDate, prevEndDate };
}

@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Public-menu analytics + order analytics for the authenticated user's
   *  company. Period is a calendar month (YYYY-MM); defaults to the current
   *  UTC month. The dashboard renders months from company.createdAt up to
   *  the current month (descending) in the period dropdown.
   *
   *  The order-metrics block is gated behind two checks:
   *    - the requester is an IQ Rest admin (email @ admin domain), and
   *    - at least one restaurant in the company has ordersEnabled = true.
   *  Both conditions must hold; otherwise `orders` is null in the response
   *  and the frontend skips the order sections. */
  @Get("stats")
  @UseGuards(AuthGuard)
  async stats(@Req() req: Request, @Query("period") periodRaw = "") {
    const { companyId, email } = (req as AuthedRequest).authUser;
    const { period, startDate, endDate, prevStartDate, prevEndDate } = monthWindow(periodRaw);

    const adminDomain = (process.env.ADMIN_EMAIL_DOMAIN || "iq-rest.com").toLowerCase();
    const isAdmin = !!email && email.toLowerCase().endsWith("@" + adminDomain);

    const [company, ordersEnabledCount] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { createdAt: true },
      }),
      this.prisma.restaurant.count({ where: { companyId, ordersEnabled: true } }),
    ]);

    const ordersFeatureOn = ordersEnabledCount > 0;
    const showOrders = isAdmin && ordersFeatureOn;

    const [
      totalViews,
      uniqSessionsRows,
      byDayRaw,
      byDayPrevRaw,
      byLangRaw,
      byPageRaw,
    ] = await Promise.all([
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

    // Order block — only fetched when the requester is an admin AND at
    // least one restaurant has ordersEnabled. Soft-deleted orders are
    // kept (Order.deletedAt is non-null but total/items still reflect the
    // real sale). Cancelled is excluded from revenue.
    const orderQueries = showOrders
      ? await Promise.all([
          this.prisma.$queryRaw<{ revenue: string | null; orders: bigint }[]>`
            SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
            FROM orders
            WHERE "companyId" = ${companyId}
              AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
              AND "isExample" = false AND status <> 'cancelled'
          `,
          this.prisma.$queryRaw<{ revenue: string | null; orders: bigint }[]>`
            SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
            FROM orders
            WHERE "companyId" = ${companyId}
              AND "createdAt" >= ${prevStartDate} AND "createdAt" < ${prevEndDate}
              AND "isExample" = false AND status <> 'cancelled'
          `,
          this.prisma.$queryRaw<{ day: string; revenue: string; orders: bigint }[]>`
            SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                   SUM(total) AS revenue,
                   COUNT(*) AS orders
            FROM orders
            WHERE "companyId" = ${companyId}
              AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
              AND "isExample" = false AND status <> 'cancelled'
            GROUP BY day
            ORDER BY day ASC
          `,
          this.prisma.$queryRaw<{ hour: number; revenue: string; orders: bigint }[]>`
            SELECT EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC')::int AS hour,
                   SUM(total) AS revenue,
                   COUNT(*) AS orders
            FROM orders
            WHERE "companyId" = ${companyId}
              AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
              AND "isExample" = false AND status <> 'cancelled'
            GROUP BY hour
            ORDER BY hour ASC
          `,
          this.prisma.order.findMany({
            where: {
              companyId,
              createdAt: { gte: startDate, lt: endDate },
              isExample: false,
              status: { not: "cancelled" },
            },
            select: { items: true },
          }),
        ])
      : null;

    const totalScans = uniqSessionsRows.length;

    // Build the orders payload (or null) without losing typing. When the
    // gate is off this short-circuits the rest of the aggregation work.
    let ordersPayload: unknown = null;
    if (orderQueries) {
      const [
        ordersAgg,
        ordersAggPrev,
        ordersByDayRaw,
        ordersByHourRaw,
        ordersForItems,
      ] = orderQueries;

      const revenue = Number(ordersAgg[0]?.revenue ?? 0);
      const orders = Number(ordersAgg[0]?.orders ?? 0);
      const revenuePrev = Number(ordersAggPrev[0]?.revenue ?? 0);
      const aov = orders > 0 ? revenue / orders : 0;

      // Aggregate items from all in-period order JSON blobs. Each
      // order.items is [{ id, name, qty, price }]. Drives top dishes,
      // items-per-order and the order-size histogram.
      interface OrderItem {
        id?: string;
        dishId?: string;
        name?: string;
        dishNameSnapshot?: Record<string, string>;
        qty?: number;
        price?: number | string;
        basePriceSnapshot?: number | string;
      }
      const itemAgg = new Map<string, { name: string; quantity: number; revenue: number }>();
      let totalQty = 0;
      for (const o of ordersForItems) {
        const items = (o.items as unknown as OrderItem[]) ?? [];
        for (const it of items) {
          const qty = Number(it.qty ?? 0);
          const price = Number(it.price ?? it.basePriceSnapshot ?? 0);
          // Group by canonical dish: dishId (new fat shape) → name (legacy
          // flat shape) → per-unit random id as last resort. The random
          // id_xxx token is unique per ordered unit, so keying off it
          // would put every unit in its own bucket.
          const key = String(it.dishId ?? it.name ?? it.id ?? "");
          if (!key) continue;
          const snapshotName = it.dishNameSnapshot
            ? Object.values(it.dishNameSnapshot)[0]
            : undefined;
          const fallbackName = String(it.name ?? snapshotName ?? key);
          const prev = itemAgg.get(key) ?? { name: fallbackName, quantity: 0, revenue: 0 };
          prev.quantity += qty;
          prev.revenue += qty * price;
          if (it.name) prev.name = String(it.name);
          else if (snapshotName) prev.name = String(snapshotName);
          itemAgg.set(key, prev);
        }
        totalQty += items.reduce((s, it) => s + Number(it.qty ?? 0), 0);
      }
      const itemsPerOrder = orders > 0 ? totalQty / orders : 0;
      const topItemsByRevenue = [...itemAgg.values()]
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);
      const topItemsByQuantity = [...itemAgg.values()]
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 10);

      const sizeBuckets = { "1": 0, "2-3": 0, "4-5": 0, "6+": 0 };
      for (const o of ordersForItems) {
        const items = (o.items as unknown as OrderItem[]) ?? [];
        const qty = items.reduce((s, it) => s + Number(it.qty ?? 0), 0);
        if (qty <= 1) sizeBuckets["1"]++;
        else if (qty <= 3) sizeBuckets["2-3"]++;
        else if (qty <= 5) sizeBuckets["4-5"]++;
        else sizeBuckets["6+"]++;
      }

      // Dense by-hour 0..23 so every slot renders even with empty hours.
      const hourMap = new Map(ordersByHourRaw.map((r) => [r.hour, r]));
      const ordersByHour: { hour: number; revenue: number; orders: number }[] = [];
      for (let h = 0; h < 24; h++) {
        const row = hourMap.get(h);
        ordersByHour.push({
          hour: h,
          revenue: row ? Number(row.revenue) : 0,
          orders: row ? Number(row.orders) : 0,
        });
      }

      ordersPayload = {
        revenue,
        revenuePrev,
        ordersCount: orders,
        aov,
        itemsPerOrder,
        currency: "EUR",
        byDay: densifyOrdersByDay(ordersByDayRaw, startDate, endDate),
        byHour: ordersByHour,
        topByRevenue: topItemsByRevenue,
        topByQuantity: topItemsByQuantity,
        sizeBuckets,
      };
    }

    return {
      period,
      companyCreatedAt: company?.createdAt?.toISOString() ?? new Date().toISOString(),
      totalViews,
      totalScans,
      byDay: densifyByDay(byDayRaw, startDate, endDate),
      byDayPrev: densifyByDay(byDayPrevRaw, prevStartDate, prevEndDate),
      byLanguage: byLangRaw.map((l) => ({ language: l.language, views: Number(l.views), scans: Number(l.scans) })),
      byPage: byPageRaw.map((p) => ({ page: p.page, views: Number(p.views), sessions: Number(p.sessions) })),
      orders: ordersPayload,
    };
  }
}
