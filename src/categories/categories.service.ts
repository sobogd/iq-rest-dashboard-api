import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AutoTranslateService } from "../auto-translate/auto-translate.service";
import { mergeTranslationsWithLocks } from "../items/items.service";

type CategoryTranslations = Record<string, { name: string }>;

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

  async create(companyId: string, body: { name: string; translations?: CategoryTranslations | null; isActive?: boolean }) {
    const max = await this.prisma.category.aggregate({
      where: { companyId },
      _max: { sortOrder: true },
    });
    const created = await this.prisma.category.create({
      data: {
        name: body.name,
        translations: (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        isActive: body.isActive ?? true,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        companyId,
      },
    });
    this.autoTranslate.scheduleCategory({
      companyId,
      categoryId: created.id,
      sourceNameChanged: true,
    });
    return created;
  }

  async update(companyId: string, id: string, body: { name?: string; translations?: CategoryTranslations | null; isActive?: boolean; sortOrder?: number }) {
    const cat = await this.prisma.category.findFirst({ where: { id, companyId } });
    if (!cat) throw new NotFoundException();
    const sourceNameChanged = body.name !== undefined && body.name !== cat.name;

    const data: Prisma.CategoryUpdateInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
    };
    if (body.translations !== undefined) {
      const merged = mergeTranslationsWithLocks(
        cat.translations as Parameters<typeof mergeTranslationsWithLocks>[0],
        body.translations as Parameters<typeof mergeTranslationsWithLocks>[1],
        ["name"],
      );
      data.translations = (merged as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    }
    const updated = await this.prisma.category.update({ where: { id }, data });
    this.autoTranslate.scheduleCategory({
      companyId,
      categoryId: updated.id,
      sourceNameChanged,
    });
    return updated;
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
