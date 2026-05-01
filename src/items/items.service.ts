import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

interface ItemUpsert {
  name: string;
  description?: string | null;
  price: number;
  imageUrl?: string | null;
  categoryId: string;
  isActive?: boolean;
  translations?: Record<string, { name?: string; description?: string }> | null;
  allergens?: string[];
  options?: unknown;
  sortOrder?: number;
}

@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: string) {
    return this.prisma.item.findMany({
      where: { companyId },
      orderBy: { sortOrder: "asc" },
    });
  }

  async create(companyId: string, body: ItemUpsert) {
    const max = await this.prisma.item.aggregate({
      where: { companyId, categoryId: body.categoryId },
      _max: { sortOrder: true },
    });
    return this.prisma.item.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        price: new Prisma.Decimal(body.price),
        imageUrl: body.imageUrl ?? null,
        categoryId: body.categoryId,
        isActive: body.isActive ?? true,
        translations: (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        allergens: body.allergens ?? [],
        options: (body.options as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        companyId,
      },
    });
  }

  async update(companyId: string, id: string, body: Partial<ItemUpsert>) {
    const item = await this.prisma.item.findFirst({ where: { id, companyId } });
    if (!item) throw new NotFoundException();
    const data: Prisma.ItemUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description ?? null;
    if (body.price !== undefined) data.price = new Prisma.Decimal(body.price);
    if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl ?? null;
    if (body.categoryId !== undefined) data.category = { connect: { id: body.categoryId } };
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.translations !== undefined)
      data.translations = (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    if (body.allergens !== undefined) data.allergens = body.allergens;
    if (body.options !== undefined) data.options = (body.options as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    // User edited a seeded sample item — drop the example flag so it stops showing the badge.
    // Triggers on default-language rename OR any translations edit (per-locale rename).
    if (item.isExample) {
      const renamedDefault = body.name !== undefined && body.name !== item.name;
      const renamedTranslations = body.translations !== undefined;
      if (renamedDefault || renamedTranslations) data.isExample = false;
    }
    return this.prisma.item.update({ where: { id }, data });
  }

  async patch(companyId: string, id: string, body: { isActive?: boolean }) {
    const item = await this.prisma.item.findFirst({ where: { id, companyId } });
    if (!item) throw new NotFoundException();
    return this.prisma.item.update({
      where: { id },
      data: { ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) },
    });
  }

  async remove(companyId: string, id: string) {
    const item = await this.prisma.item.findFirst({ where: { id, companyId } });
    if (!item) throw new NotFoundException();
    await this.prisma.item.delete({ where: { id } });
  }

  async reorder(companyId: string, itemId: string, direction: "up" | "down") {
    const item = await this.prisma.item.findFirst({ where: { id: itemId, companyId } });
    if (!item) throw new NotFoundException();
    const siblings = await this.prisma.item.findMany({
      where: { companyId, categoryId: item.categoryId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, sortOrder: true },
    });
    const idx = siblings.findIndex((it) => it.id === itemId);
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= siblings.length) return { swapped: [] };

    const a = siblings[idx];
    const b = siblings[target];
    await this.prisma.$transaction([
      this.prisma.item.update({ where: { id: a.id }, data: { sortOrder: b.sortOrder } }),
      this.prisma.item.update({ where: { id: b.id }, data: { sortOrder: a.sortOrder } }),
    ]);
    return {
      swapped: [
        { id: a.id, sortOrder: b.sortOrder },
        { id: b.id, sortOrder: a.sortOrder },
      ],
    };
  }
}
