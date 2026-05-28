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
      where: { restaurantId: ctx.restaurantId, deletedAt: null },
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
      const parent = await this.prisma.category.findFirst({ where: { id: parentId, restaurantId: ctx.restaurantId, deletedAt: null } });
      if (!parent) throw new BadRequestException("Parent group not found");
      if (!parent.isGroup) throw new BadRequestException("Parent must be a group");
    }
    const max = await this.prisma.category.aggregate({
      where: { restaurantId: ctx.restaurantId, parentId, deletedAt: null },
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

        restaurantId: ctx.restaurantId,
      },
    });
    await this.autoTranslate.translateCategory({

      restaurantId: ctx.restaurantId,
      categoryId: created.id,
      sourceNameChanged: true,
    });
    return this.prisma.category.findFirst({ where: { id: created.id } });
  }

  async update(ctx: Ctx, id: string, body: CategoryUpdateBody) {
    const cat = await this.prisma.category.findFirst({
      where: { id, restaurantId: ctx.restaurantId, deletedAt: null },
      include: {
        _count: {
          select: {
            children: { where: { deletedAt: null } },
            items: { where: { deletedAt: null } },
          },
        },
      },
    });
    if (!cat) throw new NotFoundException();
    const sourceNameChanged = body.name !== undefined && body.name !== cat.name;

    if (body.parentId !== undefined && body.parentId !== null) {
      if (body.parentId === id) throw new BadRequestException("Category cannot be its own parent");
      const parent = await this.prisma.category.findFirst({ where: { id: body.parentId, restaurantId: ctx.restaurantId, deletedAt: null } });
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
        where: { restaurantId: ctx.restaurantId, parentId: body.parentId ?? null, deletedAt: null },
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

      restaurantId: ctx.restaurantId,
      categoryId: updated.id,
      sourceNameChanged,
    });
    return this.prisma.category.findFirst({ where: { id: updated.id } });
  }

  async remove(ctx: Ctx, id: string) {
    const cat = await this.prisma.category.findFirst({ where: { id, restaurantId: ctx.restaurantId, deletedAt: null } });
    if (!cat) throw new NotFoundException();
    // Soft-delete: just mark the category deleted. Its items keep their
    // categoryId and simply stop rendering (their category is hidden) — orders
    // are self-contained snapshots, so nothing downstream breaks. Deleting a
    // group bubbles its live child categories back to top-level so they stay
    // visible (matches the previous hard-delete SetNull behaviour).
    const now = new Date();
    if (cat.isGroup) {
      await this.prisma.$transaction([
        this.prisma.category.updateMany({
          where: { parentId: id, restaurantId: ctx.restaurantId, deletedAt: null },
          data: { parentId: null },
        }),
        this.prisma.category.update({ where: { id }, data: { deletedAt: now } }),
      ]);
    } else {
      await this.prisma.category.update({ where: { id }, data: { deletedAt: now } });
    }
  }

  async reorder(ctx: Ctx, items: { id: string; sortOrder: number }[]) {
    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.category.updateMany({
          where: { id: it.id, restaurantId: ctx.restaurantId, deletedAt: null },
          data: { sortOrder: it.sortOrder },
        }),
      ),
    );
    return this.list(ctx);
  }
}
