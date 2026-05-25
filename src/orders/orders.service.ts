import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersEventsService } from "../orders-stream/orders-events.service";

interface OrderOption {
  priceDelta?: number | string | null;
  quantity?: number | null;
}
interface Discount {
  type?: string | null;
  value?: number | string | null;
}
interface OrderItem {
  basePriceSnapshot?: number | string | null;
  price?: number | string | null;
  qty?: number | null;
  options?: OrderOption[] | null;
  discount?: Discount | null;
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Apply a single discount to `base`. Percent values are clamped to [0,100]
// so a typo in the dashboard can't drive an order negative; fixed values
// are clamped to base for the same reason. Result rounded to cents.
function applyDiscount(base: number, discount: Discount | null | undefined): number {
  if (!discount) return 0;
  const value = toNumber(discount.value);
  if (value <= 0) return 0;
  if (discount.type === "percent") {
    const pct = Math.min(100, value);
    return Math.round(base * (pct / 100) * 100) / 100;
  }
  if (discount.type === "fixed") {
    return Math.round(Math.min(base, value) * 100) / 100;
  }
  return 0;
}

function itemSubtotal(raw: OrderItem): number {
  const base = toNumber(raw.basePriceSnapshot ?? raw.price);
  const extras = (raw.options ?? []).reduce(
    (sum, o) => sum + toNumber(o.priceDelta) * toNumber(o.quantity ?? 1),
    0,
  );
  const qty = toNumber(raw.qty ?? 1);
  return (base + extras) * qty;
}

function itemFinal(raw: OrderItem): number {
  const sub = itemSubtotal(raw);
  return Math.max(0, sub - applyDiscount(sub, raw.discount));
}

function calcOrderTotal(items: unknown, orderDiscount?: Discount | null): number {
  if (!Array.isArray(items)) return 0;
  let subtotal = 0;
  for (const raw of items as OrderItem[]) subtotal += itemFinal(raw);
  subtotal = Math.round(subtotal * 100) / 100;
  const final = Math.max(0, subtotal - applyDiscount(subtotal, orderDiscount ?? null));
  return Math.round(final * 100) / 100;
}

// Sum of all discounts (item-level + order-level) for a given items array +
// order discount. Stored denormalised in Order.discountTotal so analytics
// can sum without re-parsing every items JSON.
function calcDiscountTotal(items: unknown, orderDiscount?: Discount | null): number {
  if (!Array.isArray(items)) return 0;
  let itemsDiscount = 0;
  let subtotalAfterItem = 0;
  for (const raw of items as OrderItem[]) {
    const sub = itemSubtotal(raw);
    itemsDiscount += applyDiscount(sub, raw.discount);
    subtotalAfterItem += Math.max(0, sub - applyDiscount(sub, raw.discount));
  }
  const orderD = applyDiscount(Math.round(subtotalAfterItem * 100) / 100, orderDiscount ?? null);
  return Math.round((itemsDiscount + orderD) * 100) / 100;
}

interface Ctx {
  companyId: string;
  restaurantId: string;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: OrdersEventsService,
  ) {}

  // Safety ceiling so an unbounded history can't blow up the payload (the
  // admin board + every kitchen/waiter bootstrap call this). The board and
  // the KDS only ever render OPEN orders, so `openOnly` lets callers skip the
  // completed/cancelled tail entirely — that's the common, cheap path.
  list(ctx: Ctx, status?: string, from?: string, to?: string, openOnly = false) {
    const MAX_ROWS = 1000;
    const range: { gte?: Date; lte?: Date } = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) {
        d.setUTCHours(0, 0, 0, 0);
        range.gte = d;
      }
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) {
        d.setUTCHours(0, 0, 0, 0);
        range.lte = d;
      }
    }
    // A date range is self-bounding (analytics asks for a specific period and
    // needs every order in it, completed included) — don't cap those. The cap
    // guards the open-ended board/bootstrap queries that would otherwise grow
    // with the restaurant's whole history.
    const hasRange = !!(range.gte || range.lte);
    return this.prisma.order.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        deletedAt: null,
        ...(status ? { status } : {}),
        // "open" = anything still on the board: not completed, not cancelled.
        ...(openOnly && !status ? { status: { notIn: ["completed", "cancelled"] } } : {}),
        ...(hasRange ? { orderDate: range } : {}),
      },
      orderBy: { createdAt: "desc" },
      ...(hasRange ? {} : { take: MAX_ROWS }),
    });
  }

  async create(ctx: Ctx, body: { items?: unknown[]; total?: number; tableNumber?: number | null; customerName?: string | null }) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: ctx.restaurantId },
      select: { currency: true },
    });
    if (!restaurant) throw new NotFoundException("Restaurant not found");
    const orderDate = new Date();
    orderDate.setUTCHours(0, 0, 0, 0);

    const items = body.items ?? [];
    const total = calcOrderTotal(items);
    const discountTotal = calcDiscountTotal(items);

    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.order.findFirst({
        where: { restaurantId: ctx.restaurantId, orderDate },
        orderBy: { dailyNumber: "desc" },
        select: { dailyNumber: true },
      });
      const dailyNumber = (last?.dailyNumber ?? 0) + 1;
      const data: Prisma.OrderUncheckedCreateInput = {
        companyId: ctx.companyId,
        restaurantId: ctx.restaurantId,
        items: items as Prisma.InputJsonValue,
        total: new Prisma.Decimal(total),
        discountTotal: discountTotal > 0 ? new Prisma.Decimal(discountTotal) : null,
        currency: restaurant.currency,
        tableNumber: body.tableNumber ?? null,
        customerName: body.customerName ?? null,
        status: "new",
        orderDate,
        dailyNumber,
      };
      try {
        const created = await this.prisma.order.create({ data });
        await this.events.publish({
          action: "created",
          restaurantId: created.restaurantId,
          order: created,
        });
        return created;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Could not allocate daily order number");
  }

  async patch(ctx: Ctx, id: string, body: { status?: string; items?: unknown[]; total?: number; tableNumber?: number | null; paymentMethodId?: string | null; discount?: Discount | null }) {
    const order = await this.prisma.order.findFirst({ where: { id, restaurantId: ctx.restaurantId, deletedAt: null } });
    if (!order) throw new NotFoundException();
    // Whichever side (items or discount) is changing in this patch, we
    // re-derive total + discountTotal from the resulting combined state.
    const nextItems = body.items !== undefined ? body.items : (order.items as unknown);
    const nextDiscount =
      body.discount !== undefined ? body.discount : (order.discount as Discount | null);
    const recompute =
      body.items !== undefined || body.discount !== undefined || body.total !== undefined;
    const recomputed = recompute
      ? {
          total: new Prisma.Decimal(calcOrderTotal(nextItems, nextDiscount)),
          discountTotal: (() => {
            const v = calcDiscountTotal(nextItems, nextDiscount);
            return v > 0 ? new Prisma.Decimal(v) : null;
          })(),
        }
      : {};
    const isClosing = (s?: string) => s === "completed" || s === "cancelled";
    const statusBeforeUpdate =
      body.status !== undefined && isClosing(body.status) && !isClosing(order.status)
        ? { statusBeforeClose: order.status }
        : {};
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.items !== undefined ? { items: body.items as Prisma.InputJsonValue } : {}),
        ...(body.discount !== undefined
          ? { discount: (body.discount === null ? Prisma.DbNull : body.discount) as Prisma.InputJsonValue | typeof Prisma.DbNull }
          : {}),
        ...recomputed,
        ...(body.tableNumber !== undefined ? { tableNumber: body.tableNumber } : {}),
        ...(body.paymentMethodId !== undefined ? { paymentMethodId: body.paymentMethodId } : {}),
        ...statusBeforeUpdate,
      },
    });
    await this.events.publish({
      action: "updated",
      restaurantId: updated.restaurantId,
      order: updated,
    });
    return updated;
  }

  async reopen(ctx: Ctx, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, restaurantId: ctx.restaurantId, deletedAt: null } });
    if (!order) throw new NotFoundException();
    const restored = order.statusBeforeClose || "in_progress";
    const updated = await this.prisma.order.update({
      where: { id },
      data: { status: restored, statusBeforeClose: null },
    });
    await this.events.publish({
      action: "updated",
      restaurantId: updated.restaurantId,
      order: updated,
    });
    return updated;
  }

  async remove(ctx: Ctx, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, restaurantId: ctx.restaurantId, deletedAt: null } });
    if (!order) throw new NotFoundException();
    await this.prisma.order.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.events.publish({
      action: "deleted",
      restaurantId: order.restaurantId,
      orderId: id,
    });
  }

  async split(
    ctx: Ctx,
    id: string,
    body: { itemIds: string[] },
  ) {
    const { itemIds } = body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new NotFoundException("No items selected");
    }
    const order = await this.prisma.order.findFirst({ where: { id, restaurantId: ctx.restaurantId, deletedAt: null } });
    if (!order) throw new NotFoundException();

    const allItems = Array.isArray(order.items) ? (order.items as Array<{ id: string }>) : [];
    const takenSet = new Set(itemIds);
    const kept = allItems.filter((it) => !takenSet.has(it.id));
    const taken = allItems.filter((it) => takenSet.has(it.id));
    if (taken.length === 0) throw new NotFoundException("No matching items");
    // Order-level discount stays with the source order; the split-off order
    // starts clean (item-level discounts travel with their items). Recompute
    // both totals AND discountTotal so the denormalised columns stay honest —
    // previously the source kept its discount JSON but lost it from the total.
    const orderDiscount = (order.discount as Discount | null) ?? null;
    const sourceTotal = calcOrderTotal(kept, orderDiscount);
    const sourceDiscountTotal = calcDiscountTotal(kept, orderDiscount);
    const createdTotal = calcOrderTotal(taken);
    const createdDiscountTotal = calcDiscountTotal(taken);

    const orderDate = new Date();
    orderDate.setUTCHours(0, 0, 0, 0);

    return this.prisma.$transaction(async (tx) => {
      let created;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await tx.order.findFirst({
          where: { restaurantId: order.restaurantId, orderDate },
          orderBy: { dailyNumber: "desc" },
          select: { dailyNumber: true },
        });
        const dailyNumber = (last?.dailyNumber ?? 0) + 1;
        try {
          created = await tx.order.create({
            data: {
              companyId: order.companyId,
              restaurantId: order.restaurantId,
              items: taken as unknown as Prisma.InputJsonValue,
              total: new Prisma.Decimal(createdTotal),
              discountTotal: createdDiscountTotal > 0 ? new Prisma.Decimal(createdDiscountTotal) : null,
              currency: order.currency,
              tableNumber: order.tableNumber,
              customerName: order.customerName,
              status: order.status,
              orderDate,
              dailyNumber,
            },
          });
          break;
        } catch (err) {
          lastErr = err;
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            continue;
          }
          throw err;
        }
      }
      if (!created) throw lastErr ?? new Error("Could not allocate daily order number");

      const source = await tx.order.update({
        where: { id },
        data: {
          items: kept as unknown as Prisma.InputJsonValue,
          total: new Prisma.Decimal(sourceTotal),
          discountTotal: sourceDiscountTotal > 0 ? new Prisma.Decimal(sourceDiscountTotal) : null,
        },
      });

      return { source, created };
    }).then(async (res) => {
      await this.events.publish({
        action: "split",
        restaurantId: res.source.restaurantId,
        order: res.source,
        createdOrder: res.created,
      });
      return res;
    });
  }
}
