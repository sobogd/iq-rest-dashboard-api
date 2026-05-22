import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { AutoTranslateService } from "../auto-translate/auto-translate.service";
import { isReservedSlug, slugify } from "../common/reserved-slugs";
import { isPaidActive } from "../common/ai-quota";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const reservationDaySchema = z
  .object({
    closed: z.boolean(),
    from: z.string().regex(HHMM),
    to: z.string().regex(HHMM),
    lunchFrom: z.string().regex(HHMM).nullable(),
    lunchTo: z.string().regex(HHMM).nullable(),
  })
  .refine((d) => d.closed || d.from < d.to, { message: "from must be < to" })
  .refine(
    (d) => (d.lunchFrom === null) === (d.lunchTo === null),
    { message: "lunchFrom and lunchTo must both be set or both null" }
  )
  .refine(
    (d) => d.lunchFrom === null || d.lunchTo === null || d.lunchFrom < d.lunchTo,
    { message: "lunchFrom must be < lunchTo" }
  )
  .refine(
    (d) =>
      d.closed ||
      d.lunchFrom === null ||
      d.lunchTo === null ||
      (d.lunchFrom >= d.from && d.lunchTo <= d.to),
    { message: "lunch break must be inside working hours" }
  );

const reservationScheduleSchema = z.array(reservationDaySchema).length(7);

type ReservationSchedule = z.infer<typeof reservationScheduleSchema>;

interface RestaurantInput {
  title?: string;
  subtitle?: string | null;
  description?: string | null;
  slug?: string | null;
  currency?: string;
  source?: string | null;
  backgroundType?: string | null;
  accentColor?: string;
  address?: string | null;
  x?: string | null;
  y?: string | null;
  googlePlaceId?: string | null;
  phone?: string | null;
  instagram?: string | null;
  whatsapp?: string | null;
  languages?: string[];
  defaultLanguage?: string;
  hideTitle?: boolean;
  menuLayout?: string;
  paymentMethods?: string[];
  reservationsEnabled?: boolean;
  reservationMode?: string;
  reservationSlotMinutes?: number;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  reservationSchedule?: ReservationSchedule | null;
  timezone?: string;
  ordersEnabled?: boolean;
  orderNameEnabled?: boolean;
  orderPhoneEnabled?: boolean;
  orderAddressEnabled?: boolean;
  orderMode?: string;
}

const FIELDS: (keyof RestaurantInput)[] = [
  "title", "subtitle", "description", "slug", "currency", "source", "backgroundType",
  "accentColor", "address", "x", "y", "googlePlaceId", "phone", "instagram", "whatsapp", "languages",
  "defaultLanguage", "hideTitle", "menuLayout", "paymentMethods", "reservationsEnabled", "reservationMode",
  "reservationSlotMinutes", "workingHoursStart", "workingHoursEnd",
  "reservationSchedule", "timezone", "ordersEnabled",
  "orderNameEnabled", "orderPhoneEnabled", "orderAddressEnabled", "orderMode",
];

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function pickFields(raw: Record<string, unknown>): RestaurantInput {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (raw[f] !== undefined) out[f] = raw[f];
  if (out.reservationSchedule !== undefined && out.reservationSchedule !== null) {
    const parsed = reservationScheduleSchema.safeParse(out.reservationSchedule);
    if (!parsed.success) {
      throw new BadRequestException(
        "Invalid reservationSchedule: " + parsed.error.issues[0]?.message
      );
    }
    out.reservationSchedule = parsed.data;
  }
  if (out.timezone !== undefined) {
    const tz = String(out.timezone).trim();
    if (!tz || !isValidTimezone(tz)) {
      throw new BadRequestException("Invalid timezone: must be IANA identifier (e.g. Europe/Rome)");
    }
    out.timezone = tz;
  }
  if (out.menuLayout !== undefined) {
    const v = String(out.menuLayout);
    if (v !== "flat" && v !== "drill") {
      throw new BadRequestException("Invalid menuLayout: must be 'flat' or 'drill'");
    }
    out.menuLayout = v;
  }
  if (out.slug !== undefined && out.slug !== null) {
    // Normalise and re-check reserved set so a user-typed slug can't slip
    // past the auto-allocator's reserve checks. Without this, posting
    // `slug: "k"` directly would land tenants on `/m/k` which collides
    // with the kitchen subdomain and other infrastructure reservations.
    const cleaned = slugify(String(out.slug));
    if (!cleaned) {
      throw new BadRequestException("Invalid slug");
    }
    if (isReservedSlug(cleaned)) {
      throw new BadRequestException("slug_reserved");
    }
    out.slug = cleaned;
  }
  if (out.paymentMethods !== undefined) {
    if (!Array.isArray(out.paymentMethods)) {
      throw new BadRequestException("paymentMethods must be an array of strings");
    }
    const allowed = new Set([
      "cash", "card", "iban", "yemeksipeti", "trendyolyemek", "stripe", "uber_eats", "glovo",
    ]);
    const cleaned = (out.paymentMethods as unknown[])
      .map((v) => String(v).trim().toLowerCase())
      .filter((v) => allowed.has(v));
    out.paymentMethods = Array.from(new Set(cleaned));
  }
  return out as RestaurantInput;
}

@Injectable()
export class RestaurantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoTranslate: AutoTranslateService,
  ) {}

  /** Active restaurant (by id from AuthGuard). */
  async getActive(restaurantId: string) {
    return this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
  }

  /** All restaurants for company. Soft-hide non-primary on FREE plan. */
  async listForCompany(companyId: string) {
    const [company, restaurants] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { plan: true, subscriptionStatus: true },
      }),
      this.prisma.restaurant.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const paid = company ? isPaidActive(company) : false;
    if (!paid && restaurants.length > 1) {
      return restaurants.slice(0, 1);
    }
    return restaurants;
  }

  /**
   * Update active restaurant. If no restaurant exists for the company, create
   * one (legacy onboarding path — pre-seed users hit POST /restaurant before
   * any restaurant exists).
   */
  async upsert(companyId: string, restaurantId: string | null, raw: Record<string, unknown>) {
    const input = pickFields(raw);

    const { reservationSchedule, ...rest } = input;
    const scheduleField =
      reservationSchedule === undefined
        ? {}
        : reservationSchedule === null
          ? { reservationSchedule: Prisma.DbNull }
          : { reservationSchedule: reservationSchedule as Prisma.InputJsonValue };

    if (restaurantId) {
      const existing = await this.prisma.restaurant.findFirst({
        where: { id: restaurantId, companyId },
      });
      if (!existing) throw new NotFoundException("Restaurant not found");
      const updated = await this.prisma.restaurant.update({
        where: { id: existing.id },
        data: { ...(rest as Prisma.RestaurantUpdateInput), ...scheduleField },
      });
      const prevLangs = existing.languages || [];
      const nextLangs = updated.languages || [];
      const added = nextLangs.filter((l) => !prevLangs.includes(l));
      const removed = prevLangs.filter((l) => !nextLangs.includes(l));
      const defaultChanged =
        existing.defaultLanguage !== updated.defaultLanguage &&
        !!existing.defaultLanguage && !!updated.defaultLanguage;
      if (removed.length) {
        await this.autoTranslate.removeLanguagesFromMenu(updated.id, removed);
      }
      if (defaultChanged) {
        await this.autoTranslate.swapMenuDefaultLanguage(
          updated.id,
          existing.defaultLanguage,
          updated.defaultLanguage,
        );
      }
      if (added.length) {
        await this.autoTranslate.runMenuBackfill(updated.id);
      }
      return updated;
    }

    const slug = rest.slug || (await this.uniqueSlug(rest.title || "rest"));
    const createData: Prisma.RestaurantUncheckedCreateInput = {
      companyId,
      title: rest.title || "",
      slug,
      currency: rest.currency || "EUR",
      accentColor: rest.accentColor || "#000000",
      languages: rest.languages || ["en"],
      defaultLanguage: rest.defaultLanguage || "en",
      startedFromScratch: true,
      ...rest,
      ...scheduleField,
    };
    return this.prisma.restaurant.create({ data: createData });
  }

  /**
   * Create additional restaurant for a company. PRO-gated.
   * If duplicateFromId is given, copies categories+items+settings from that
   * restaurant (same company). Tables/orders/reservations/page_views are NOT
   * copied — physical/historical.
   */
  async createForCompany(
    companyId: string,
    body: { name: string; duplicateFromId?: string | null },
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { plan: true, subscriptionStatus: true },
    });
    if (!company) throw new NotFoundException("Company not found");
    if (!isPaidActive(company)) {
      throw new ForbiddenException("multi_restaurant_requires_paid");
    }

    const name = (body.name || "").trim();
    if (!name) throw new BadRequestException("Name required");

    const slug = await this.uniqueSlug(name);

    let source: Awaited<ReturnType<typeof this.prisma.restaurant.findUnique>> | null = null;
    if (body.duplicateFromId) {
      source = await this.prisma.restaurant.findFirst({
        where: { id: body.duplicateFromId, companyId },
      });
      if (!source) throw new BadRequestException("Source restaurant not found");
    }

    // Carry settings forward from source (if duplicating) or use the
    // current primary's languages/currency as a sane starting default.
    const fallback = source
      ? null
      : await this.prisma.restaurant.findFirst({
          where: { companyId },
          orderBy: { createdAt: "asc" },
        });
    const baseSettings = source ?? fallback;

    // Duplicate carries the source restaurant's full language list. Blank
    // inherits only the company's working language (primary's defaultLanguage)
    // so the user can add more from /settings/languages — copying every
    // language would force translations on a menu that doesn't exist yet.
    const blankDefaultLang = baseSettings?.defaultLanguage ?? "en";
    const languages = source ? source.languages : [blankDefaultLang];
    const defaultLanguage = source ? source.defaultLanguage : blankDefaultLang;

    const created = await this.prisma.restaurant.create({
      data: {
        companyId,
        title: name,
        slug,
        currency: baseSettings?.currency ?? "EUR",
        accentColor: baseSettings?.accentColor ?? "#000000",
        languages,
        defaultLanguage,
        menuLayout: baseSettings?.menuLayout ?? "flat",
        paymentMethods: baseSettings?.paymentMethods ?? ["cash", "card"],
        timezone: baseSettings?.timezone ?? "UTC",
        startedFromScratch: !source,
      },
    });

    if (source) {
      await this.duplicateMenu(source.id, created.id, created.companyId);
    }

    return created;
  }

  /** Copy categories + items (with translations) from one restaurant to another. */
  private async duplicateMenu(fromRestaurantId: string, toRestaurantId: string, toCompanyId: string) {
    const cats = await this.prisma.category.findMany({
      where: { restaurantId: fromRestaurantId },
      orderBy: { sortOrder: "asc" },
    });
    const idMap = new Map<string, string>();
    // First pass: create categories without parentId.
    for (const c of cats) {
      const created = await this.prisma.category.create({
        data: {
          name: c.name,
          translations: (c.translations ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          sortOrder: c.sortOrder,
          isActive: c.isActive,
          isGroup: c.isGroup,
          companyId: toCompanyId,
          restaurantId: toRestaurantId,
        },
      });
      idMap.set(c.id, created.id);
    }
    // Second pass: wire parentId.
    for (const c of cats) {
      if (!c.parentId) continue;
      const newId = idMap.get(c.id);
      const newParent = idMap.get(c.parentId);
      if (newId && newParent) {
        await this.prisma.category.update({
          where: { id: newId },
          data: { parentId: newParent },
        });
      }
    }
    const items = await this.prisma.item.findMany({
      where: { restaurantId: fromRestaurantId, deletedAt: null },
      orderBy: { sortOrder: "asc" },
    });
    for (const it of items) {
      const newCatId = idMap.get(it.categoryId);
      if (!newCatId) continue;
      await this.prisma.item.create({
        data: {
          name: it.name,
          description: it.description,
          translations: (it.translations ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          price: it.price,
          imageUrl: it.imageUrl,
          allergens: it.allergens,
          diets: it.diets,
          options: (it.options ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          sortOrder: it.sortOrder,
          isActive: it.isActive,
          isExample: it.isExample,
          categoryId: newCatId,
          companyId: toCompanyId,
          restaurantId: toRestaurantId,
        },
      });
    }
  }

  async deleteForCompany(companyId: string, restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId, companyId },
    });
    if (!restaurant) throw new NotFoundException();
    const remaining = await this.prisma.restaurant.count({ where: { companyId } });
    if (remaining <= 1) {
      throw new BadRequestException("Cannot delete the last restaurant");
    }
    await this.prisma.restaurant.delete({ where: { id: restaurantId } });
  }

  /** Compute the slug that would be allocated for `seed` without writing
   *  anything. Used by the dashboard's "URL preview" field as the user types. */
  async previewSlug(seed: string): Promise<string> {
    return this.uniqueSlug(seed);
  }

  private async uniqueSlug(seed: string): Promise<string> {
    const base = slugify(seed) || "rest";
    // Incremental suffix on collision: base, base1, base2, ... — readable and
    // predictable. Reserved words always carry a suffix.
    let i = isReservedSlug(base) ? 1 : 0;
    while (true) {
      const candidate = i === 0 ? base : `${base}${i}`;
      const taken = await this.prisma.restaurant.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken && !isReservedSlug(candidate)) return candidate;
      i++;
      if (i > 9999) throw new Error(`Could not allocate a unique slug for "${seed}"`);
    }
  }
}
