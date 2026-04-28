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

  async create(companyId: string, body: { items: unknown[]; total?: number; tableNumber?: number | null; customerName?: string | null }) {
    return this.prisma.order.create({
      data: {
        companyId,
        items: body.items as Prisma.InputJsonValue,
        total: body.total !== undefined ? new Prisma.Decimal(body.total) : null,
        tableNumber: body.tableNumber ?? null,
        customerName: body.customerName ?? null,
        status: "active",
      },
    });
  }

  async patch(companyId: string, id: string, body: { status?: string; items?: unknown[]; total?: number }) {
    const order = await this.prisma.order.findFirst({ where: { id, companyId } });
    if (!order) throw new NotFoundException();
    return this.prisma.order.update({
      where: { id },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.items !== undefined ? { items: body.items as Prisma.InputJsonValue } : {}),
        ...(body.total !== undefined ? { total: new Prisma.Decimal(body.total) } : {}),
      },
    });
  }

  async remove(companyId: string, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, companyId } });
    if (!order) throw new NotFoundException();
    await this.prisma.order.delete({ where: { id } });
  }
}
