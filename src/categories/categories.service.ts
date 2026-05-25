import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AutoTranslateService } from "../auto-translate/auto-translate.service";
import { mergeTranslationsWithLocks } from "../items/items.service";

type CategoryTranslations = Record<string, { name: string }>;

interface CategoryCreateBody {
  name: string;
  translations?: CategoryTranslations | null;
  isActive?: boolean;
  isGroup?: boolean;
  parentId?: string | null;
}

interface CategoryUpdateBody {
  name?: string;
  translations?: CategoryTranslations | null;
  isActive?: boolean;
  sortOrder?: number;
  isGroup?: boolean;
  parentId?: string | null;
}

interface Ctx {
  companyId: string;
  restaurantId: string;
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoTranslate: AutoTranslateService,
  ) {}

  list(ctx: Ctx) {
    return this.prisma.category.findMany({
      where: { restaurantId: ctx.restaurantId },
      orderBy: { sortOrder: "asc" },
      take: 2000,
    });
  }

  async create(ctx: Ctx, body: CategoryCreateBody) {
    const isGroup = body.isGroup === true;
    const parentId = body.parentId ?? null;
    if (isGroup && parentId) {
      throw new BadRequestException("A group cannot itself have a parent group");
    }
    if (parentId) {
      const parent = await this.prisma.category.findFirst({ where: { id: parentId, restaurantId: ctx.restaurantId } });
      if (!parent) throw new BadRequestException("Parent group not found");
      if (!parent.isGroup) throw new BadRequestException("Parent must be a group");
    }
    const max = await this.prisma.category.aggregate({
      where: { restaurantId: ctx.restaurantId, parentId },
      _max: { sortOrder: true },
    });
    const created = await this.prisma.category.create({
      data: {
        name: body.name,
        translations: (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        isActive: body.isActive ?? true,
        isGroup,
        parentId,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        companyId: ctx.companyId,
        restaurantId: ctx.restaurantId,
      },
    });
    await this.autoTranslate.translateCategory({
      companyId: ctx.companyId,
      restaurantId: ctx.restaurantId,
      categoryId: created.id,
      sourceNameChanged: true,
    });
    return this.prisma.category.findFirst({ where: { id: created.id } });
  }

  async update(ctx: Ctx, id: string, body: CategoryUpdateBody) {
    const cat = await this.prisma.category.findFirst({
      where: { id, restaurantId: ctx.restaurantId },
      include: { _count: { select: { children: true, items: true } } },
    });
    if (!cat) throw new NotFoundException();
    const sourceNameChanged = body.name !== undefined && body.name !== cat.name;

    if (body.parentId !== undefined && body.parentId !== null) {
      if (body.parentId === id) throw new BadRequestException("Category cannot be its own parent");
      const parent = await this.prisma.category.findFirst({ where: { id: body.parentId, restaurantId: ctx.restaurantId } });
      if (!parent) throw new BadRequestException("Parent group not found");
      if (!parent.isGroup) throw new BadRequestException("Parent must be a group");
      if (cat.isGroup) throw new BadRequestException("A group cannot itself have a parent group");
    }
    if (body.isGroup === true && cat._count.items > 0) {
      throw new BadRequestException("Cannot convert to group: category still has items");
    }
    if (body.isGroup === false && cat._count.children > 0) {
      throw new BadRequestException("Cannot convert to leaf: group still has sub-categories");
    }

    // Moving to a different parent (group ↔ top-level) must re-seat the category
    // at the end of its new sibling list — otherwise it keeps its old sortOrder
    // and collides/misorders among the new siblings. Skip when the caller sent
    // an explicit sortOrder (a drag-reorder), which already places it.
    let movedSortOrder: number | undefined;
    if (
      body.parentId !== undefined &&
      body.parentId !== cat.parentId &&
      body.sortOrder === undefined
    ) {
      const max = await this.prisma.category.aggregate({
        where: { restaurantId: ctx.restaurantId, parentId: body.parentId ?? null },
        _max: { sortOrder: true },
      });
      movedSortOrder = (max._max.sortOrder ?? -1) + 1;
    }

    const data: Prisma.CategoryUpdateInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(movedSortOrder !== undefined ? { sortOrder: movedSortOrder } : {}),
      ...(body.isGroup !== undefined ? { isGroup: body.isGroup } : {}),
      ...(body.parentId !== undefined
        ? body.parentId === null
          ? { parent: { disconnect: true } }
          : { parent: { connect: { id: body.parentId } } }
        : {}),
    };
    if (body.translations !== undefined) {
      const merged = mergeTranslationsWithLocks(
        cat.translations as Parameters<typeof mergeTranslationsWithLocks>[0],
        body.translations as Parameters<typeof mergeTranslationsWithLocks>[1],
        ["name"],
        sourceNameChanged ? ["name"] : [],
      );
      data.translations = (merged as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    }
    const updated = await this.prisma.category.update({ where: { id }, data });
    await this.autoTranslate.translateCategory({
      companyId: ctx.companyId,
      restaurantId: ctx.restaurantId,
      categoryId: updated.id,
      sourceNameChanged,
    });
    return this.prisma.category.findFirst({ where: { id: updated.id } });
  }

  async remove(ctx: Ctx, id: string) {
    const cat = await this.prisma.category.findFirst({ where: { id, restaurantId: ctx.restaurantId } });
    if (!cat) throw new NotFoundException();
    // Just drop the category. The FK is ON DELETE SET NULL, so its items stay
    // ALIVE and orphaned (categoryId -> null) — they keep resolving orders'
    // dishId + analytics, and the dashboard surfaces them in a synthetic
    // "No category" bucket so the owner can re-file or delete them. (Groups
    // have no items; their child categories bubble to top-level via the parent
    // SetNull relation.)
    await this.prisma.category.delete({ where: { id } });
  }

  async reorder(ctx: Ctx, items: { id: string; sortOrder: number }[]) {
    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.category.updateMany({
          where: { id: it.id, restaurantId: ctx.restaurantId },
          data: { sortOrder: it.sortOrder },
        }),
      ),
    );
    return this.list(ctx);
  }
}
