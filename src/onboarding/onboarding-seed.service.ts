import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { isSupportedCurrency } from "../common/stripe";
import { cuisineTemplates, SAMPLE_PREFIX, type LocaleString } from "./cuisine-templates";
import { isReservedSlug, slugify } from "../common/reserved-slugs";

// Locales for which we ship at least subtitle/category/item translations. Anything outside this
// set falls back to "en" — both for the dashboard default language and for guest-name samples.
const SUPPORTED_SEED_LOCALES = new Set([
  "en", "es", "de", "fr", "it", "pt", "nl", "pl", "ru", "uk",
  "sv", "da", "no", "fi", "cs", "el", "tr", "ro", "hu", "bg",
  "hr", "sk", "sl", "et", "lv", "lt", "sr", "ca", "ga", "is",
  "fa", "ar", "ja", "ko", "zh",
]);

function pickSeedLocale(locale: string | null | undefined): string {
  if (!locale) return "en";
  const short = locale.toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_SEED_LOCALES.has(short) ? short : "en";
}

/** Pick the localised string for `loc`, falling back to English if missing. */
function pick(s: LocaleString | undefined, loc: string): string | undefined {
  if (!s) return undefined;
  return s[loc] ?? s.en;
}

/** Build the translations JSON column from a multilingual string, including only entries that
 *  actually carry content (skip empty/undefined values). The source-language entry is omitted
 *  because the menu rendering reads it from the row's primary `name` column instead — leaving
 *  it duplicated in `translations[sourceLang]` causes drift if the owner renames the dish
 *  later (the public menu would keep showing the old template name in the source language). */
function buildNameTranslations(name: LocaleString, sourceLang: string): Record<string, { name: string }> {
  const out: Record<string, { name: string }> = {};
  for (const [lang, value] of Object.entries(name)) {
    if (lang === sourceLang) continue;
    if (typeof value === "string" && value.length > 0) out[lang] = { name: value };
  }
  return out;
}

function buildItemTranslations(
  name: LocaleString,
  description: LocaleString | undefined,
  sourceLang: string,
): Record<string, { name: string; description?: string }> {
  const out: Record<string, { name: string; description?: string }> = {};
  const langs = new Set<string>([...Object.keys(name), ...(description ? Object.keys(description) : [])]);
  for (const lang of langs) {
    if (lang === sourceLang) continue;
    const n = name[lang];
    if (typeof n !== "string" || n.length === 0) continue;
    const entry: { name: string; description?: string } = { name: n };
    const d = description?.[lang];
    if (typeof d === "string" && d.length > 0) entry.description = d;
    out[lang] = entry;
  }
  return out;
}

@Injectable()
export class OnboardingSeedService {
  private readonly logger = new Logger(OnboardingSeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Seed a brand-new user with an EMPTY restaurant (no menu, single language,
   *  blank title) so the dashboard's AuthGuard has a restaurant to resolve. The
   *  first-login onboarding wizard then collects the name and offers to fill
   *  demo data. Idempotent: aborts if the user already has an attached
   *  restaurant. The new restaurant is the user's FIRST → 14-day trial. */
  async seedEmptyRestaurant(params: {
    userId: string;
    currency: string;
    locale: string | null | undefined;
  }): Promise<{ restaurantId: string } | null> {
    const { userId, currency } = params;
    const seedLocale = pickSeedLocale(params.locale);

    const existing = await this.prisma.restaurantUser.findFirst({
      where: { userId },
      select: { restaurantId: true },
    });
    if (existing) {
      this.logger.log(`Skipping seed for user ${userId} — restaurant already attached`);
      return null;
    }

    // Title is intentionally blank — the onboarding modal collects it. Pick a
    // pretty random slug (adjective-noun) instead of "restaurant1/2/3…".
    const slug = await this.generatePrettySlug();

    return this.prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          title: "",
          slug,
          currency,
          // Scandinavian menu currencies double as billing currencies; else EUR.
          billingCurrency: isSupportedCurrency(currency) ? currency : "EUR",
          // Dark accent by default for newly onboarded restaurants.
          accentColor: "#1A1A1A",
          // Globe-icon language switcher over the hero for new restaurants.
          languageSwitcher: "top",
          // Single language only — onboarding "start from scratch" keeps one
          // language; demo-fill doesn't add more either.
          languages: [seedLocale],
          defaultLanguage: seedLocale,
          ordersEnabled: false,
          reservationsEnabled: true,
          plan: "FREE",
          subscriptionStatus: "INACTIVE",
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });

      // Link the seeding user to the new restaurant via the flat access model.
      // addedBy is null for the FIRST user of a restaurant (the creator).
      await tx.restaurantUser.create({
        data: { restaurantId: restaurant.id, userId, addedBy: null },
      });

      return { restaurantId: restaurant.id };
    });
  }

  /** Fill an existing (empty) restaurant with demo data: the generic template
   *  menu ("Sample: …" dishes) plus a fully-populated floor — tables, bookings
   *  and live orders — so the owner can explore every feature. Idempotent:
   *  aborts (returns ok:false) if the restaurant already has any items, so a
   *  double-click can't duplicate the menu. Does NOT flip onboardingDone — the
   *  caller owns that. */
  async fillDemo(restaurantId: string): Promise<{ ok: boolean }> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, currency: true, defaultLanguage: true },
    });
    if (!restaurant) return { ok: false };

    const existingItems = await this.prisma.item.count({ where: { restaurantId } });
    if (existingItems > 0) return { ok: false };

    const seedLocale = pickSeedLocale(restaurant.defaultLanguage);
    const currency = restaurant.currency;
    const template = cuisineTemplates.restaurant;

    await this.prisma.$transaction(async (tx) => {
      // Categories — default-lang name + JSON translations. Sequential awaits
      // (Promise.all on the same tx can violate isolation).
      const createdCategories: Array<{ id: string }> = [];
      for (const cat of template.categories) {
        const created = await tx.category.create({
          data: {
            restaurantId,
            name: pick(cat.name, seedLocale)!,
            translations: buildNameTranslations(cat.name, seedLocale),
            sortOrder: cat.sortOrder,
          },
        });
        createdCategories.push(created);
      }

      // Items — "Sample: " prefixed so the owner can spot and replace them.
      const createdItems: Array<{
        id: string;
        name: string;
        price: { toString(): string };
        nameMl: Record<string, string>;
      }> = [];
      for (const item of template.items) {
        const category = createdCategories[item.categoryIndex];
        const sampleName: LocaleString = {} as LocaleString;
        const nameMl: Record<string, string> = {};
        for (const [lang, value] of Object.entries(item.name)) {
          if (typeof value === "string" && value.length > 0) {
            const prefix = SAMPLE_PREFIX[lang] || SAMPLE_PREFIX.en;
            sampleName[lang] = `${prefix}${value}`;
            nameMl[lang] = sampleName[lang];
          }
        }
        const created = await tx.item.create({
          data: {
            restaurantId,
            categoryId: category.id,
            name: pick(sampleName, seedLocale)!,
            description: pick(item.description, seedLocale),
            translations: buildItemTranslations(sampleName, item.description, seedLocale),
            price: item.price,
            sortOrder: item.sortOrder,
            ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
          },
        });
        createdItems.push({ ...created, nameMl });
      }

      // Turn orders on so the seeded sample orders are visible, then lay down
      // the tables + bookings + live orders.
      await tx.restaurant.update({ where: { id: restaurantId }, data: { ordersEnabled: true } });
      if (createdItems.length > 0) {
        await this.seedDemoExtras(tx, restaurantId, currency, createdItems);
      }
    });

    return { ok: true };
  }

  /** Populate a demo restaurant's floor: a tidy grid of tables, a handful of
   *  reservations across statuses/times, and a few live orders built from the
   *  seeded dishes. Runs inside the seed transaction. */
  private async seedDemoExtras(
    tx: Prisma.TransactionClient,
    restaurantId: string,
    currency: string,
    items: Array<{ id: string; price: { toString(): string }; nameMl: Record<string, string> }>,
  ): Promise<void> {
    // Tidy 2-row layout in floor-map percent coords. Mix of capacities/zones.
    const MAIN = "Main hall";
    const TERRACE = "Terrace";
    // Mixed shapes, sizes (percent of map) and rotations so the demo floor
    // looks like a real, hand-laid plan rather than a uniform grid.
    const tableSpecs = [
      { number: 1, capacity: 2, zone: MAIN, x: 16, y: 19, shape: "circle", width: 13, height: 13, rotation: 0 },
      { number: 2, capacity: 4, zone: MAIN, x: 45, y: 18, shape: "rect", width: 23, height: 13, rotation: 0 },
      { number: 3, capacity: 6, zone: MAIN, x: 80, y: 20, shape: "circle", width: 21, height: 21, rotation: 0 },
      { number: 4, capacity: 2, zone: MAIN, x: 15, y: 47, shape: "rect", width: 12, height: 12, rotation: 0 },
      { number: 5, capacity: 8, zone: MAIN, x: 47, y: 48, shape: "rect", width: 27, height: 15, rotation: 0 },
      { number: 6, capacity: 4, zone: MAIN, x: 81, y: 50, shape: "circle", width: 18, height: 18, rotation: 0 },
      { number: 7, capacity: 4, zone: TERRACE, x: 21, y: 78, shape: "rect", width: 21, height: 12, rotation: 15 },
      { number: 8, capacity: 6, zone: TERRACE, x: 53, y: 80, shape: "rect", width: 23, height: 16, rotation: -12 },
      { number: 9, capacity: 2, zone: TERRACE, x: 83, y: 77, shape: "circle", width: 14, height: 14, rotation: 0 },
    ];
    const tables: Array<{ id: string; number: number }> = [];
    for (const spec of tableSpecs) {
      const t = await tx.table.create({
        data: {
          restaurantId,
          number: spec.number,
          capacity: spec.capacity,
          zone: spec.zone,
          x: spec.x,
          y: spec.y,
          shape: spec.shape,
          width: spec.width,
          height: spec.height,
          rotation: spec.rotation,
          sortOrder: spec.number,
        },
      });
      tables.push({ id: t.id, number: t.number });
    }

    // Reservations — today + tomorrow, varied statuses. @db.Date stores the
    // date part only; the wall-clock time lives in startTime.
    const today = new Date();
    const dateOnly = (offsetDays: number) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offsetDays));
      return d;
    };
    const reservationSpecs = [
      { tableIdx: 5, date: 0, startTime: "19:00", duration: 120, guestName: "Anna Schmidt", guestsCount: 6, status: "confirmed" },
      { tableIdx: 2, date: 0, startTime: "20:00", duration: 90, guestName: "Marco Rossi", guestsCount: 4, status: "pending" },
      { tableIdx: 0, date: 0, startTime: "13:00", duration: 60, guestName: "Yuki Tanaka", guestsCount: 2, status: "completed" },
      { tableIdx: 3, date: 1, startTime: "19:30", duration: 120, guestName: "Sophie Martin", guestsCount: 4, status: "confirmed" },
      { tableIdx: 6, date: 0, startTime: "21:00", duration: 90, guestName: "Liam O'Brien", guestsCount: 2, status: "pending" },
    ];
    for (const r of reservationSpecs) {
      const table = tables[r.tableIdx];
      await tx.reservation.create({
        data: {
          restaurantId,
          tableId: table.id,
          date: dateOnly(r.date),
          startTime: r.startTime,
          duration: r.duration,
          guestName: r.guestName,
          guestEmail: `${r.guestName.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
          guestsCount: r.guestsCount,
          status: r.status,
        },
      });
    }

    // Live orders built from the seeded dishes. Each item is a snapshot row in
    // the shape the dashboard/KDS expect ({ id, dishId, dishNameSnapshot,
    // basePriceSnapshot, options, notes, status, createdAt }).
    const nowIso = new Date().toISOString();
    const pick = (i: number) => items[i % items.length];
    const lineItem = (src: ReturnType<typeof pick>, status: string, idx: number) => ({
      id: `seed_${idx}_${src.id}`,
      dishId: src.id,
      dishNameSnapshot: src.nameMl,
      basePriceSnapshot: src.price.toString(),
      options: [] as unknown[],
      notes: "",
      status,
      createdAt: nowIso,
      discount: null,
    });
    const orderSpecs: Array<{ tableNumber: number; status: string; lines: Array<{ i: number; status: string }> }> = [
      { tableNumber: 6, status: "in_progress", lines: [{ i: 0, status: "cooking" }, { i: 1, status: "pending" }] },
      { tableNumber: 3, status: "new", lines: [{ i: 2, status: "pending" }, { i: 3, status: "pending" }, { i: 0, status: "ready" }] },
      { tableNumber: 1, status: "in_progress", lines: [{ i: 4, status: "served" }, { i: 5, status: "cooking" }] },
    ];
    let dailyNumber = 1;
    for (const o of orderSpecs) {
      const lines = o.lines.map((l, idx) => lineItem(pick(l.i), l.status, idx));
      const total = lines.reduce((sum, l) => sum + Number(l.basePriceSnapshot || 0), 0);
      await tx.order.create({
        data: {
          restaurantId,
          items: lines as unknown as Prisma.InputJsonValue,
          total,
          currency,
          tableNumber: o.tableNumber,
          status: o.status,
          orderDate: dateOnly(0),
          dailyNumber: dailyNumber++,
        },
      });
    }
  }

  // Pretty-slug word pools — adjective + noun gives ~20×20 = 400 readable
  // combinations (e.g. "cozy-bistro", "golden-pantry"), used for the public
  // URL of a brand-new empty restaurant instead of "restaurant1/2/3…".
  private static readonly SLUG_ADJ = [
    "cozy", "golden", "rustic", "sunny", "urban", "little", "grand", "hidden",
    "royal", "fresh", "savory", "velvet", "amber", "copper", "olive", "crimson",
    "hearty", "lively", "modern", "classic",
  ];
  private static readonly SLUG_NOUN = [
    "kitchen", "table", "fork", "spoon", "plate", "bistro", "eatery", "pantry",
    "grill", "hearth", "feast", "harvest", "supper", "garden", "corner", "market",
    "larder", "oven", "cellar", "table-spot",
  ];

  /** Pick a pretty, unique adjective-noun slug for a brand-new empty restaurant.
   *  Tries random combinations; after a few collisions it adds a short random
   *  suffix, and ultimately falls back to the incremental `uniqueSlug`. */
  private async generatePrettySlug(): Promise<string> {
    const adj = OnboardingSeedService.SLUG_ADJ;
    const noun = OnboardingSeedService.SLUG_NOUN;
    const rand = (n: number) => Math.floor(Math.random() * n);
    for (let attempt = 0; attempt < 30; attempt++) {
      let candidate = `${adj[rand(adj.length)]}-${noun[rand(noun.length)]}`;
      // After enough collisions, disambiguate with a short base36 suffix.
      if (attempt >= 12) candidate += `-${Math.random().toString(36).slice(2, 5)}`;
      if (isReservedSlug(candidate)) continue;
      const taken = await this.prisma.restaurant.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    // Extremely unlikely fallback — incremental "rest", "rest1", …
    return this.uniqueSlug("rest");
  }

  /** Mirror RestaurantService.uniqueSlug — kept private to the seeder so it doesn't pull in
   *  the whole restaurant module just for one helper. Always returns a random suffix on
   *  collision (no time-based fallback that could collide between concurrent seeds). When
   *  the slugified seed lands on a reserved word ("test", "admin", etc.), behave as if it
   *  were taken so a random suffix is appended — the visible restaurant name stays as the
   *  user typed; only the URL slug becomes unique. */
  private async uniqueSlug(seed: string): Promise<string> {
    const base = slugify(seed) || "rest";
    // Incremental suffix on collision: base, base1, base2, ...
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
