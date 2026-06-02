import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { Prisma } from "@prisma/client";
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

function monthWindow(periodRaw: string): {
  period: string;
  startDate: Date;
  endDate: Date;
  prevStartDate: Date;
  prevEndDate: Date;
} {
  const now = new Date();

  if (periodRaw === "today") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    const prevStart = new Date(start);
    prevStart.setUTCDate(prevStart.getUTCDate() - 1);
    return { period: "today", startDate: start, endDate: end, prevStartDate: prevStart, prevEndDate: start };
  }

  if (periodRaw === "week") {
    const day = now.getUTCDay();
    const daysFromMonday = (day + 6) % 7;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    const prevStart = new Date(start);
    prevStart.setUTCDate(prevStart.getUTCDate() - 7);
    return { period: "week", startDate: start, endDate: end, prevStartDate: prevStart, prevEndDate: start };
  }

  const match = /^(\d{4})-(\d{2})$/.exec(periodRaw);
  let year: number;
  let month0: number;
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
   *  active restaurant (default) or every restaurant they own/manage when
   *  scope=all. Period is a calendar month (YYYY-MM); defaults to the current
   *  UTC month. */
  @Get("stats")
  @UseGuards(AuthGuard)
  async stats(
    @Req() req: Request,
    @Query("period") periodRaw = "",
    @Query("scope") scope = "",
  ) {
    const { userId, restaurantId, viaGrant } = (req as AuthedRequest).authUser;
    const { period, startDate, endDate, prevStartDate, prevEndDate } = monthWindow(periodRaw);

    // scope=all aggregates across every restaurant the user can access. A
    // user viewing a restaurant granted to them must never see the owner's
    // other restaurants — force single-restaurant scope in that case.
    const isAll = scope === "all" && !viaGrant;

    // Resolve the user's full restaurant set once. Each row is owned (addedBy
    // == null) or attached as manager (addedBy != null). For scope=all we
    // only aggregate the owned set so a manager's stats don't leak into the
    // owner's totals (and vice versa).
    const ownedRus = await this.prisma.restaurantUser.findMany({
      where: { userId, addedBy: null },
      select: { restaurant: { select: { id: true, createdAt: true } } },
      orderBy: { addedAt: "asc" },
    });
    const ownedRestaurantIds = ownedRus.map((ru) => ru.restaurant.id);
    const scopeRestaurantIds = isAll && ownedRestaurantIds.length
      ? ownedRestaurantIds
      : [restaurantId];

    // Resolve restaurant filter once for all queries.
    const pvScopeWhere = Prisma.sql`"restaurantId" = ANY(${scopeRestaurantIds}::text[])`;
    const orderScopeWhere = Prisma.sql`"restaurantId" = ANY(${scopeRestaurantIds}::text[])`;

    // Synthetic "account created at" — earliest restaurant the user owns,
    // falls back to now when they own none (manager-only access).
    const accountCreatedAt = ownedRus[0]?.restaurant.createdAt ?? new Date();

    const pvFilterWhere = {
      restaurantId: { in: scopeRestaurantIds },
      createdAt: { gte: startDate, lt: endDate },
    };

    const [
      totalViews,
      uniqSessionsRows,
      byDayRaw,
      byDayPrevRaw,
      byLangRaw,
      byPageRaw,
    ] = await Promise.all([
      this.prisma.pageView.count({ where: pvFilterWhere }),
      this.prisma.pageView.groupBy({
        by: ["sessionId"],
        where: pvFilterWhere,
      }),
      this.prisma.$queryRaw<{ day: string; views: bigint; scans: bigint }[]>`
        SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               COUNT(*) AS views,
               COUNT(DISTINCT "sessionId") AS scans
        FROM page_views
        WHERE ${pvScopeWhere} AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
        GROUP BY day
        ORDER BY day ASC
      `,
      this.prisma.$queryRaw<{ day: string; views: bigint; scans: bigint }[]>`
        SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               COUNT(*) AS views,
               COUNT(DISTINCT "sessionId") AS scans
        FROM page_views
        WHERE ${pvScopeWhere} AND "createdAt" >= ${prevStartDate} AND "createdAt" < ${prevEndDate}
        GROUP BY day
        ORDER BY day ASC
      `,
      this.prisma.$queryRaw<{ language: string; views: bigint; scans: bigint }[]>`
        SELECT language, COUNT(*) AS views, COUNT(DISTINCT "sessionId") AS scans
        FROM page_views
        WHERE ${pvScopeWhere} AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
        GROUP BY language
        ORDER BY views DESC
      `,
      this.prisma.$queryRaw<{ page: string; views: bigint; sessions: bigint }[]>`
        SELECT page, COUNT(*) AS views, COUNT(DISTINCT "sessionId") AS sessions
        FROM page_views
        WHERE ${pvScopeWhere} AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
        GROUP BY page
        ORDER BY views DESC
      `,
    ]);

    const orderFilterWhere = {
      restaurantId: { in: scopeRestaurantIds },
      status: "completed",
    };

    const orderQueries = await Promise.all([
          this.prisma.$queryRaw<{ revenue: string | null; orders: bigint }[]>`
            SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
            FROM orders
            WHERE ${orderScopeWhere}
              AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
              AND status = 'completed'
          `,
          this.prisma.$queryRaw<{ revenue: string | null; orders: bigint }[]>`
            SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
            FROM orders
            WHERE ${orderScopeWhere}
              AND "createdAt" >= ${prevStartDate} AND "createdAt" < ${prevEndDate}
              AND status = 'completed'
          `,
          this.prisma.$queryRaw<{ day: string; revenue: string; orders: bigint }[]>`
            SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                   SUM(total) AS revenue,
                   COUNT(*) AS orders
            FROM orders
            WHERE ${orderScopeWhere}
              AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
              AND status = 'completed'
            GROUP BY day
            ORDER BY day ASC
          `,
          this.prisma.$queryRaw<{ day: string; revenue: string; orders: bigint }[]>`
            SELECT TO_CHAR("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                   SUM(total) AS revenue,
                   COUNT(*) AS orders
            FROM orders
            WHERE ${orderScopeWhere}
              AND "createdAt" >= ${prevStartDate} AND "createdAt" < ${prevEndDate}
              AND status = 'completed'
            GROUP BY day
            ORDER BY day ASC
          `,
          this.prisma.$queryRaw<{ hour: number; revenue: string; orders: bigint }[]>`
            SELECT EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC')::int AS hour,
                   SUM(total) AS revenue,
                   COUNT(*) AS orders
            FROM orders
            WHERE ${orderScopeWhere}
              AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
              AND status = 'completed'
            GROUP BY hour
            ORDER BY hour ASC
          `,
          this.prisma.order.findMany({
            where: {
              ...orderFilterWhere,
              createdAt: { gte: startDate, lt: endDate },
            },
            select: { items: true, restaurantId: true },
          }),
          this.prisma.restaurant.findMany({
            where: { id: { in: scopeRestaurantIds } },
            select: { id: true, defaultLanguage: true, paymentMethods: true },
          }),
          // Revenue + order count grouped by the payment method chosen at close.
          this.prisma.$queryRaw<{ method: string | null; revenue: string; orders: bigint }[]>`
            SELECT "paymentMethodId" AS method,
                   COALESCE(SUM(total), 0) AS revenue,
                   COUNT(*) AS orders
            FROM orders
            WHERE ${orderScopeWhere}
              AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
              AND status = 'completed'
            GROUP BY "paymentMethodId"
          `,
        ]);

    const totalScans = uniqSessionsRows.length;

    let ordersPayload: unknown = null;
    {
      const [
        ordersAgg,
        ordersAggPrev,
        ordersByDayRaw,
        ordersByDayPrevRaw,
        ordersByHourRaw,
        ordersForItems,
        restaurantsForLang,
        ordersByPaymentRaw,
      ] = orderQueries;

      const restaurantDefaultLang = new Map<string, string>();
      const paymentMethodSet = new Set<string>();
      for (const r of restaurantsForLang) {
        restaurantDefaultLang.set(r.id, r.defaultLanguage || "en");
        for (const m of r.paymentMethods ?? []) paymentMethodSet.add(m);
      }
      // Enabled payment methods across the resolved scope. The UI shows the
      // breakdown only when more than one method is enabled.
      const paymentMethods = [...paymentMethodSet];
      const byPaymentMethod = ordersByPaymentRaw
        .map((r) => ({
          method: r.method ?? "unspecified",
          revenue: Number(r.revenue),
          orders: Number(r.orders),
        }))
        .sort((a, b) => b.revenue - a.revenue);

      const revenue = Number(ordersAgg[0]?.revenue ?? 0);
      const orders = Number(ordersAgg[0]?.orders ?? 0);
      const revenuePrev = Number(ordersAggPrev[0]?.revenue ?? 0);
      const aov = orders > 0 ? revenue / orders : 0;

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
        const defaultLang = restaurantDefaultLang.get(o.restaurantId) ?? "en";
        for (const it of items) {
          const qty = Number(it.qty ?? 0);
          const price = Number(it.price ?? it.basePriceSnapshot ?? 0);
          const key = String(it.dishId ?? it.name ?? it.id ?? "");
          if (!key) continue;
          const snap = it.dishNameSnapshot;
          const snapDefault = snap?.[defaultLang];
          const snapAny = snap ? Object.values(snap)[0] : undefined;
          const resolvedName = String(snapDefault ?? snapAny ?? it.name ?? key);
          const prev = itemAgg.get(key) ?? { name: resolvedName, quantity: 0, revenue: 0 };
          prev.quantity += qty;
          prev.revenue += qty * price;
          prev.name = resolvedName;
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
        byDayPrev: densifyOrdersByDay(ordersByDayPrevRaw, prevStartDate, prevEndDate),
        byHour: ordersByHour,
        topByRevenue: topItemsByRevenue,
        topByQuantity: topItemsByQuantity,
        sizeBuckets,
        paymentMethods,
        byPaymentMethod,
      };
    }

    return {
      period,
      scope: isAll ? "all" : "restaurant",
      accountCreatedAt: accountCreatedAt.toISOString(),
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
