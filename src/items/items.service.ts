import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AutoTranslateService } from "../auto-translate/auto-translate.service";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoTranslate: AutoTranslateService,
  ) {}

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
    const created = await this.prisma.item.create({
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
    // New item — treat as if both source fields just changed; auto-translate
    // fills any missing additional-language slots. Sync so the response
    // already includes the freshly-translated translations.
    await this.autoTranslate.translateItem({
      companyId,
      itemId: created.id,
      sourceNameChanged: true,
      sourceDescriptionChanged: !!body.description,
    });
    return this.prisma.item.findFirst({ where: { id: created.id } });
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
    // Persist translations with lock flags merged. A field becomes locked
    // when the user manually edits it to a non-empty value; unlocked when
    // they clear it. Locked fields are never auto-overwritten.
    if (body.translations !== undefined) {
      const merged = mergeTranslationsWithLocks(
        item.translations as TranslationsRow | null,
        body.translations as Record<string, { name?: string; description?: string }> | null,
        ["name", "description"],
      );
      data.translations = (merged as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    }
    if (body.allergens !== undefined) data.allergens = body.allergens;
    if (body.options !== undefined) data.options = (body.options as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    // User edited a seeded sample item — drop the example flag so it stops showing the badge.
    if (item.isExample) {
      const renamedDefault = body.name !== undefined && body.name !== item.name;
      const renamedTranslations = body.translations !== undefined;
      if (renamedDefault || renamedTranslations) data.isExample = false;
    }
    const sourceNameChanged = body.name !== undefined && body.name !== item.name;
    const sourceDescriptionChanged =
      body.description !== undefined && (body.description ?? null) !== (item.description ?? null);
    const updated = await this.prisma.item.update({ where: { id }, data });
    await this.autoTranslate.translateItem({
      companyId,
      itemId: updated.id,
      sourceNameChanged,
      sourceDescriptionChanged,
    });
    return this.prisma.item.findFirst({ where: { id: updated.id } });
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

type TranslationsRow = Record<string, {
  name?: string | null;
  description?: string | null;
  nameLocked?: boolean;
  descriptionLocked?: boolean;
}>;

/**
 * Merge incoming translations into the previous row, recomputing per-field
 * lock flags. A field is `locked` when the user manually changes it to a
 * non-empty value (we never auto-overwrite locked fields). Clearing a field
 * unlocks it — the next save can re-fill it via auto-translate.
 *
 * `fields` is the list of translatable text fields per language (items have
 * name+description, categories have only name).
 */
export function mergeTranslationsWithLocks(
  prev: TranslationsRow | null,
  incoming: TranslationsRow | null | undefined,
  fields: ("name" | "description")[],
): TranslationsRow | null {
  if (incoming === null) return null;
  const out: TranslationsRow = {};
  const langs = new Set<string>([
    ...Object.keys(prev || {}),
    ...Object.keys(incoming || {}),
  ]);
  for (const lang of langs) {
    const p = (prev || {})[lang] || {};
    const i = (incoming || {})[lang] || {};
    const row: TranslationsRow[string] = {};
    for (const f of fields) {
      const lockKey = (f === "name" ? "nameLocked" : "descriptionLocked") as
        "nameLocked" | "descriptionLocked";
      const incomingHas = (incoming || {})[lang] && i[f] !== undefined;
      let value = incomingHas ? (i[f] ?? null) : (p[f] ?? null);
      let locked = !!p[lockKey];
      if (incomingHas && (i[f] ?? null) !== (p[f] ?? null)) {
        // user actively touched this field — lock if non-empty, unlock if cleared
        locked = !!(i[f] && (i[f] ?? "").length > 0);
      }
      if (value !== null && value !== undefined) row[f] = value;
      if (locked) row[lockKey] = true;
    }
    if (Object.keys(row).length > 0) out[lang] = row;
  }
  return out;
}
