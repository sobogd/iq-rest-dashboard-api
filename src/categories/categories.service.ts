import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type CategoryTranslations = Record<string, { name: string }>;

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.category.create({
      data: {
        name: body.name,
        translations: (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        isActive: body.isActive ?? true,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
        companyId,
      },
    });
  }

  async update(companyId: string, id: string, body: { name?: string; translations?: CategoryTranslations | null; isActive?: boolean; sortOrder?: number }) {
    const cat = await this.prisma.category.findFirst({ where: { id, companyId } });
    if (!cat) throw new NotFoundException();
    return this.prisma.category.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.translations !== undefined
          ? { translations: (body.translations as Prisma.InputJsonValue) ?? Prisma.JsonNull }
          : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      },
    });
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
