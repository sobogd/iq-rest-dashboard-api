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

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoTranslate: AutoTranslateService,
  ) {}

  list(companyId: string) {
    return this.prisma.category.findMany({
      where: { companyId },
      orderBy: { sortOrder: "asc" },
    });
  }

  async create(companyId: string, body: CategoryCreateBody) {
    const isGroup = body.isGroup === true;
    const parentId = body.parentId ?? null;
    if (isGroup && parentId) {
      throw new BadRequestException("A group cannot itself have a parent group");
    }
    if (parentId) {
      const parent = await this.prisma.category.findFirst({ where: { id: parentId, companyId } });
      if (!parent) throw new BadRequestException("Parent group not found");
      if (!parent.isGroup) throw new BadRequestException("Parent must be a group");
    }
    // sortOrder is scoped to siblings (same parentId), so groups and leaves
    // each get their own ordered list.
    const max = await this.prisma.category.aggregate({
      where: { companyId, parentId },
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
        companyId,
      },
    });
    await this.autoTranslate.translateCategory({
      companyId,
      categoryId: created.id,
      sourceNameChanged: true,
    });
    return this.prisma.category.findFirst({ where: { id: created.id } });
  }

  async update(companyId: string, id: string, body: CategoryUpdateBody) {
    const cat = await this.prisma.category.findFirst({
      where: { id, companyId },
      include: { _count: { select: { children: true, items: true } } },
    });
    if (!cat) throw new NotFoundException();
    const sourceNameChanged = body.name !== undefined && body.name !== cat.name;

    if (body.parentId !== undefined && body.parentId !== null) {
      if (body.parentId === id) throw new BadRequestException("Category cannot be its own parent");
      const parent = await this.prisma.category.findFirst({ where: { id: body.parentId, companyId } });
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

    const data: Prisma.CategoryUpdateInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
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
      companyId,
      categoryId: updated.id,
      sourceNameChanged,
    });
    return this.prisma.category.findFirst({ where: { id: updated.id } });
  }

  async remove(companyId: string, id: string) {
    const cat = await this.prisma.category.findFirst({ where: { id, companyId } });
    if (!cat) throw new NotFoundException();
    await this.prisma.category.delete({ where: { id } });
  }

  async reorder(companyId: string, items: { id: string; sortOrder: number }[]) {
    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.category.updateMany({
          where: { id: it.id, companyId },
          data: { sortOrder: it.sortOrder },
        }),
      ),
    );
    return this.list(companyId);
  }
}
