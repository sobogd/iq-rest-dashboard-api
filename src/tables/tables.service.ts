import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

interface TableUpsert {
  number: number;
  capacity: number;
  zone?: string | null;
  imageUrl?: string | null;
  x?: number | null;
  y?: number | null;
  isActive?: boolean;
  sortOrder?: number;
  translations?: Record<string, { zone?: string }> | null;
}

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService) {}

  private async restaurantId(companyId: string) {
    const r = await this.prisma.restaurant.findFirst({ where: { companyId }, select: { id: true } });
    return r?.id;
  }

  async list(companyId: string) {
    const rid = await this.restaurantId(companyId);
    if (!rid) return [];
    return this.prisma.table.findMany({
      where: { restaurantId: rid },
      orderBy: { sortOrder: "asc" },
    });
  }

  async create(companyId: string, body: TableUpsert) {
    const rid = await this.restaurantId(companyId);
    if (!rid) throw new NotFoundException("Restaurant not found");
    const max = await this.prisma.table.aggregate({
      where: { restaurantId: rid },
      _max: { sortOrder: true },
    });
    return this.prisma.table.create({
      data: {
        number: body.number,
        capacity: body.capacity,
        zone: body.zone ?? null,
        imageUrl: body.imageUrl ?? null,
        x: body.x ?? null,
        y: body.y ?? null,
        isActive: body.isActive ?? true,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        translations: (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        restaurantId: rid,
      },
    });
  }

  async update(companyId: string, id: string, body: Partial<TableUpsert>) {
    const rid = await this.restaurantId(companyId);
    if (!rid) throw new NotFoundException();
    const tbl = await this.prisma.table.findFirst({ where: { id, restaurantId: rid } });
    if (!tbl) throw new NotFoundException();
    const data: Prisma.TableUpdateInput = {};
    if (body.number !== undefined) data.number = body.number;
    if (body.capacity !== undefined) data.capacity = body.capacity;
    if (body.zone !== undefined) data.zone = body.zone ?? null;
    if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl ?? null;
    if (body.x !== undefined) data.x = body.x ?? null;
    if (body.y !== undefined) data.y = body.y ?? null;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    if (body.translations !== undefined)
      data.translations = (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    return this.prisma.table.update({ where: { id }, data });
  }

  async remove(companyId: string, id: string) {
    const rid = await this.restaurantId(companyId);
    if (!rid) throw new NotFoundException();
    const tbl = await this.prisma.table.findFirst({ where: { id, restaurantId: rid } });
    if (!tbl) throw new NotFoundException();
    await this.prisma.table.delete({ where: { id } });
  }
}
