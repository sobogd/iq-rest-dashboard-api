import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersEventsService } from "../orders-stream/orders-events.service";

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
  return Math.round(total * 100) / 100;
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

  list(ctx: Ctx, status?: string, from?: string, to?: string) {
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
        restaurantId: ctx.restaurantId,
        deletedAt: null,
        ...(status ? { status } : {}),
        ...(range.gte || range.lte ? { orderDate: range } : {}),
      },
      orderBy: { createdAt: "desc" },
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

  async patch(ctx: Ctx, id: string, body: { status?: string; items?: unknown[]; total?: number; tableNumber?: number | null; paymentMethodId?: string | null }) {
    const order = await this.prisma.order.findFirst({ where: { id, restaurantId: ctx.restaurantId, deletedAt: null } });
    if (!order) throw new NotFoundException();
    const totalUpdate =
      body.items !== undefined
        ? { total: new Prisma.Decimal(calcOrderTotal(body.items)) }
        : body.total !== undefined
        ? { total: new Prisma.Decimal(body.total) }
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
    body: { itemIds: string[]; sourceTotal?: number; createdTotal?: number },
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
    const sourceTotal = calcOrderTotal(kept);
    const createdTotal = calcOrderTotal(taken);

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
