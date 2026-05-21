import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

interface TableUpsert {
  number: number;
  capacity: number;
  zone?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  color?: string | null;
  x?: number | null;
  y?: number | null;
  isActive?: boolean;
  sortOrder?: number;
  translations?: Record<string, { zone?: string; description?: string }> | null;
}

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(restaurantId: string) {
    return this.prisma.table.findMany({
      where: { restaurantId, deletedAt: null },
      orderBy: { sortOrder: "asc" },
    });
  }

  async create(restaurantId: string, body: TableUpsert) {
    const max = await this.prisma.table.aggregate({
      where: { restaurantId },
      _max: { sortOrder: true },
    });
    return this.prisma.table.create({
      data: {
        number: body.number,
        capacity: body.capacity,
        zone: body.zone ?? null,
        description: body.description ?? null,
        imageUrl: body.imageUrl ?? null,
        color: body.color ?? null,
        x: body.x ?? null,
        y: body.y ?? null,
        isActive: body.isActive ?? true,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        translations: (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        restaurantId,
      },
    });
  }

  async update(restaurantId: string, id: string, body: Partial<TableUpsert>) {
    const tbl = await this.prisma.table.findFirst({ where: { id, restaurantId, deletedAt: null } });
    if (!tbl) throw new NotFoundException();
    const data: Prisma.TableUpdateInput = {};
    if (body.number !== undefined) data.number = body.number;
    if (body.capacity !== undefined) data.capacity = body.capacity;
    if (body.zone !== undefined) data.zone = body.zone ?? null;
    if (body.description !== undefined) data.description = body.description ?? null;
    if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl ?? null;
    if (body.color !== undefined) data.color = body.color ?? null;
    if (body.x !== undefined) data.x = body.x ?? null;
    if (body.y !== undefined) data.y = body.y ?? null;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    if (body.translations !== undefined)
      data.translations = (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    return this.prisma.table.update({ where: { id }, data });
  }

  async remove(restaurantId: string, id: string) {
    const tbl = await this.prisma.table.findFirst({ where: { id, restaurantId, deletedAt: null } });
    if (!tbl) throw new NotFoundException();
    await this.prisma.table.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
