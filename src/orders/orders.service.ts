import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: string, status?: string) {
    return this.prisma.order.findMany({
      where: { companyId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(companyId: string, body: { items?: unknown[]; total?: number; tableNumber?: number | null; customerName?: string | null }) {
    const restaurant = await this.prisma.restaurant.findFirst({ where: { companyId }, select: { id: true, currency: true } });
    if (!restaurant) throw new NotFoundException("Restaurant not found");
    const orderDate = new Date();
    orderDate.setUTCHours(0, 0, 0, 0);

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
        items: (body.items ?? []) as Prisma.InputJsonValue,
        total: new Prisma.Decimal(body.total ?? 0),
        currency: restaurant.currency,
        tableNumber: body.tableNumber ?? null,
        customerName: body.customerName ?? null,
        status: "new",
        orderDate,
        dailyNumber,
      };
      try {
        return await this.prisma.order.create({ data });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Could not allocate daily order number");
  }

  async patch(companyId: string, id: string, body: { status?: string; items?: unknown[]; total?: number; tableNumber?: number | null }) {
    const order = await this.prisma.order.findFirst({ where: { id, companyId } });
    if (!order) throw new NotFoundException();
    return this.prisma.order.update({
      where: { id },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.items !== undefined ? { items: body.items as Prisma.InputJsonValue } : {}),
        ...(body.total !== undefined ? { total: new Prisma.Decimal(body.total) } : {}),
        ...(body.tableNumber !== undefined ? { tableNumber: body.tableNumber } : {}),
      },
    });
  }

  async remove(companyId: string, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, companyId } });
    if (!order) throw new NotFoundException();
    await this.prisma.order.delete({ where: { id } });
  }

  // Atomic split: создаёт новый Order с выбранными items, исходный обновляет (items без выбранных).
  // Возвращает { source, created }.
  async split(
    companyId: string,
    id: string,
    body: { itemIds: string[]; sourceTotal: number; createdTotal: number },
  ) {
    const { itemIds, sourceTotal, createdTotal } = body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new NotFoundException("No items selected");
    }
    const order = await this.prisma.order.findFirst({ where: { id, companyId } });
    if (!order) throw new NotFoundException();

    const allItems = Array.isArray(order.items) ? (order.items as Array<{ id: string }>) : [];
    const takenSet = new Set(itemIds);
    const kept = allItems.filter((it) => !takenSet.has(it.id));
    const taken = allItems.filter((it) => takenSet.has(it.id));
    if (taken.length === 0) throw new NotFoundException("No matching items");

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
    });
  }
}
