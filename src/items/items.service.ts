import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { AutoTranslateService } from "../auto-translate/auto-translate.service";

const mlSchema = z.record(z.string(), z.string());
const variantSchema = z.object({
  id: z.string().min(1),
  name: mlSchema.nullable().optional(),
  priceDelta: z.union([z.string(), z.number()]).optional(),
}).passthrough();
const optionSchema = z.object({
  id: z.string().min(1),
  name: mlSchema.nullable().optional(),
  type: z.enum(["single", "multi"]).optional(),
  required: z.boolean().optional(),
  variants: z.array(variantSchema).optional(),
}).passthrough();
const optionsArraySchema = z.array(optionSchema).nullable();

function validateOptions(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  const parsed = optionsArraySchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException("Invalid options payload");
  return parsed.data;
}

interface ItemUpsert {
  name: string;
  description?: string | null;
  price: number;
  imageUrl?: string | null;
  categoryId: string;
  isActive?: boolean;
  translations?: Record<string, { name?: string; description?: string }> | null;
  allergens?: string[];
  diets?: string[];
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
      where: { companyId, deletedAt: null },
      orderBy: { sortOrder: "asc" },
    });
  }

  async create(companyId: string, body: ItemUpsert) {
    const cat = await this.prisma.category.findFirst({
      where: { id: body.categoryId, companyId },
      select: { isGroup: true },
    });
    if (!cat) throw new BadRequestException("Category not found");
    if (cat.isGroup) throw new BadRequestException("Cannot add items to a group category");
    const max = await this.prisma.item.aggregate({
      where: { companyId, categoryId: body.categoryId, deletedAt: null },
      _max: { sortOrder: true },
    });
    const validatedOptions = validateOptions(body.options);
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
        diets: body.diets ?? [],
        options: (validatedOptions as Prisma.InputJsonValue) ?? Prisma.JsonNull,
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
    const item = await this.prisma.item.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!item) throw new NotFoundException();
    const data: Prisma.ItemUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description ?? null;
    if (body.price !== undefined) data.price = new Prisma.Decimal(body.price);
    if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl ?? null;
    if (body.categoryId !== undefined) {
      const targetCat = await this.prisma.category.findFirst({
        where: { id: body.categoryId, companyId },
        select: { isGroup: true },
      });
      if (!targetCat) throw new BadRequestException("Category not found");
      if (targetCat.isGroup) throw new BadRequestException("Cannot move item to a group category");
      data.category = { connect: { id: body.categoryId } };
    }
    if (body.isActive !== undefined) data.isActive = body.isActive;
    // Persist translations with lock flags merged. A field becomes locked
    // when the user manually edits it to a non-empty value; unlocked when
    // they clear it. Locked fields are never auto-overwritten.
    const sourceNameChangedForMerge = body.name !== undefined && body.name !== item.name;
    const sourceDescriptionChangedForMerge =
      body.description !== undefined && (body.description ?? null) !== (item.description ?? null);
    if (body.translations !== undefined) {
      const resetLocks: ("name" | "description")[] = [];
      if (sourceNameChangedForMerge) resetLocks.push("name");
      if (sourceDescriptionChangedForMerge) resetLocks.push("description");
      const merged = mergeTranslationsWithLocks(
        item.translations as TranslationsRow | null,
        body.translations as Record<string, { name?: string; description?: string }> | null,
        ["name", "description"],
        resetLocks,
      );
      data.translations = (merged as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    }
    if (body.allergens !== undefined) data.allergens = body.allergens;
    if (body.diets !== undefined) data.diets = body.diets;
    if (body.options !== undefined) {
      // Validate shape before any further work so a malformed payload is
      // rejected before it touches the auto-translate path.
      const validatedOptions = validateOptions(body.options);
      // When the default-language name of an option or variant changes, wipe
      // every non-default lang for that node so the auto-translator refills
      // them on this save. Without the wipe a "dish of the day" rename to
      // options stays frozen in the previous language.
      const restaurant = await this.prisma.restaurant.findFirst({
        where: { companyId },
        select: { defaultLanguage: true },
      });
      const defaultLang = restaurant?.defaultLanguage || "en";
      const prevOptions = Array.isArray(item.options) ? (item.options as DishOptLike[]) : [];
      const nextOptions = resetTargetLangsOnSourceRename(prevOptions, validatedOptions, defaultLang);
      data.options = (nextOptions as Prisma.InputJsonValue) ?? Prisma.JsonNull;
    }
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
    const item = await this.prisma.item.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!item) throw new NotFoundException();
    return this.prisma.item.update({
      where: { id },
      data: { ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) },
    });
  }

  async remove(companyId: string, id: string) {
    const item = await this.prisma.item.findFirst({ where: { id, companyId, deletedAt: null } });
    if (!item) throw new NotFoundException();
    await this.prisma.item.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async reorderBulk(companyId: string, items: { id: string; sortOrder: number }[]) {
    if (!Array.isArray(items) || items.length === 0) return { ok: true };
    await this.prisma.$transaction(
      items.map((it) =>
        this.prisma.item.updateMany({
          where: { id: it.id, companyId, deletedAt: null },
          data: { sortOrder: it.sortOrder },
        }),
      ),
    );
    return { ok: true };
  }

  async reorder(companyId: string, itemId: string, direction: "up" | "down") {
    const item = await this.prisma.item.findFirst({ where: { id: itemId, companyId } });
    if (!item) throw new NotFoundException();
    const siblings = await this.prisma.item.findMany({
      where: { companyId, categoryId: item.categoryId, deletedAt: null },
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

type DishOptLike = {
  id?: string;
  name?: Record<string, string> | null;
  variants?: DishVarLike[] | null;
  [k: string]: unknown;
};
type DishVarLike = {
  id?: string;
  name?: Record<string, string> | null;
  [k: string]: unknown;
};

// When an option or variant default-lang name changes vs the previous save,
// drop every non-default lang value for that node. The auto-translator's
// "target missing → fill" path will re-create them in the same request.
export function resetTargetLangsOnSourceRename(
  prevOptions: DishOptLike[],
  incomingOptionsRaw: unknown,
  defaultLang: string,
): DishOptLike[] | null {
  if (incomingOptionsRaw === null) return null;
  if (!Array.isArray(incomingOptionsRaw)) return [];
  const prevById = new Map<string, DishOptLike>();
  for (const p of prevOptions) if (p?.id) prevById.set(p.id, p);
  return (incomingOptionsRaw as DishOptLike[]).map((opt) => {
    if (!opt || typeof opt !== "object") return opt;
    const prev = opt.id ? prevById.get(opt.id) : undefined;
    const prevDefault = (prev?.name?.[defaultLang] ?? "").trim();
    const nextDefault = (opt.name?.[defaultLang] ?? "").trim();
    let name = opt.name ? { ...opt.name } : opt.name ?? null;
    if (prev && prevDefault && nextDefault && prevDefault !== nextDefault) {
      name = { [defaultLang]: nextDefault };
    }
    let variants = opt.variants;
    if (Array.isArray(variants)) {
      const prevVarsById = new Map<string, DishVarLike>();
      for (const pv of prev?.variants || []) if (pv?.id) prevVarsById.set(pv.id, pv);
      variants = variants.map((v) => {
        if (!v || typeof v !== "object") return v;
        const prevV = v.id ? prevVarsById.get(v.id) : undefined;
        const pVal = (prevV?.name?.[defaultLang] ?? "").trim();
        const nVal = (v.name?.[defaultLang] ?? "").trim();
        let vName = v.name ? { ...v.name } : v.name ?? null;
        if (prevV && pVal && nVal && pVal !== nVal) {
          vName = { [defaultLang]: nVal };
        }
        return { ...v, name: vName };
      });
    }
    return { ...opt, name, variants };
  });
}

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
  // When the source-language field changes, prior per-lang locks for that
  // field must be wiped so auto-translate can refresh every language. Without
  // this, a "dish of the day" pattern (PT renamed daily, translations once
  // edited by hand and then locked) keeps yesterday's translations forever.
  resetLocksOn: ("name" | "description")[] = [],
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
      // If the source language changed for this field, drop the prior lock.
      const sourceFieldChanged = resetLocksOn.includes(f);
      let locked = sourceFieldChanged ? false : !!p[lockKey];
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
