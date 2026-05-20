import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersEventsService } from "../orders-stream/orders-events.service";

// Recomputes an order's total from its item snapshot. Matches the frontend's
// calcItemPrice formula bit-for-bit:
//   item_total = (basePriceSnapshot + sum(option.priceDelta * option.qty)) * (item.qty || 1)
// Server is the source of truth for total — clients may submit `total` for
// transitional reasons but the server always overrides on writes so two
// devices can't disagree.
interface OrderOption {
  priceDelta?: number | string | null;
  quantity?: number | null;
}
interface OrderItem {
  basePriceSnapshot?: number | string | null;
  price?: number | string | null;
  qty?: number | null;
  options?: OrderOption[] | null;
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function calcOrderTotal(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const raw of items as OrderItem[]) {
    const base = toNumber(raw.basePriceSnapshot ?? raw.price);
    const extras = (raw.options ?? []).reduce(
      (sum, o) => sum + toNumber(o.priceDelta) * toNumber(o.quantity ?? 1),
      0,
    );
    const qty = toNumber(raw.qty ?? 1);
    total += (base + extras) * qty;
  }
  // Round to 2 decimals using cents to avoid float drift.
  return Math.round(total * 100) / 100;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: OrdersEventsService,
  ) {}

  list(companyId: string, status?: string, from?: string, to?: string) {
    // Optional date-range filter (analytics modal). `from` / `to` are ISO
    // strings; when present we constrain on the `orderDate` column (a date,
    // not a timestamp, so we widen to inclusive day boundaries).
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
    return this.prisma.order.findMany({
      where: {
        companyId,
        deletedAt: null,
        ...(status ? { status } : {}),
        ...(range.gte || range.lte ? { orderDate: range } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(companyId: string, body: { items?: unknown[]; total?: number; tableNumber?: number | null; customerName?: string | null }) {
    const restaurant = await this.prisma.restaurant.findFirst({ where: { companyId }, select: { id: true, currency: true } });
    if (!restaurant) throw new NotFoundException("Restaurant not found");
    const orderDate = new Date();
    orderDate.setUTCHours(0, 0, 0, 0);

    const items = body.items ?? [];
    const total = calcOrderTotal(items);

    // Retry on unique collision when two creates race on same (restaurant, day, number).
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.order.findFirst({
        where: { restaurantId: restaurant.id, orderDate },
        orderBy: { dailyNumber: "desc" },
        select: { dailyNumber: true },
      });
      const dailyNumber = (last?.dailyNumber ?? 0) + 1;
      const data: Prisma.OrderUncheckedCreateInput = {
        companyId,
        restaurantId: restaurant.id,
        items: items as Prisma.InputJsonValue,
        total: new Prisma.Decimal(total),
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

  async patch(companyId: string, id: string, body: { status?: string; items?: unknown[]; total?: number; tableNumber?: number | null; paymentMethodId?: string | null }) {
    const order = await this.prisma.order.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!order) throw new NotFoundException();
    // Server-side total recalc. When `items` changes we always recompute
    // from the new array; client-provided `total` is honoured only for the
    // legacy items-untouched code path (e.g. status flip) to avoid silently
    // accepting a wrong number.
    const totalUpdate =
      body.items !== undefined
        ? { total: new Prisma.Decimal(calcOrderTotal(body.items)) }
        : body.total !== undefined
        ? { total: new Prisma.Decimal(body.total) }
        : {};
    // When the new status closes the order (completed/cancelled) and the
    // previous one was active, remember the previous status so Reopen can
    // restore exactly that.
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
        ...totalUpdate,
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

  async reopen(companyId: string, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!order) throw new NotFoundException();
    // Restore exactly the status the order had at close time. If we don't
    // know (legacy closed orders), fall back to "in_progress" so it shows up
    // on the kitchen board.
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

  async remove(companyId: string, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!order) throw new NotFoundException();
    await this.prisma.order.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.events.publish({
      action: "deleted",
      restaurantId: order.restaurantId,
      orderId: id,
    });
  }

  // Atomic split: создаёт новый Order с выбранными items, исходный обновляет (items без выбранных).
  // Возвращает { source, created }.
  async split(
    companyId: string,
    id: string,
    body: { itemIds: string[]; sourceTotal?: number; createdTotal?: number },
  ) {
    const { itemIds } = body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new NotFoundException("No items selected");
    }
    const order = await this.prisma.order.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!order) throw new NotFoundException();

    const allItems = Array.isArray(order.items) ? (order.items as Array<{ id: string }>) : [];
    const takenSet = new Set(itemIds);
    const kept = allItems.filter((it) => !takenSet.has(it.id));
    const taken = allItems.filter((it) => takenSet.has(it.id));
    if (taken.length === 0) throw new NotFoundException("No matching items");
    // Server-side totals — ignore client values to keep money math honest.
    const sourceTotal = calcOrderTotal(kept);
    const createdTotal = calcOrderTotal(taken);

    const orderDate = new Date();
    orderDate.setUTCHours(0, 0, 0, 0);

    return this.prisma.$transaction(async (tx) => {
      // Allocate dailyNumber with retry on collision inside tx.
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
