import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { CuisineKey } from "./cuisine";
import { cuisineTemplates, commonPlaceholders, sampleGuestNames, type LocaleString } from "./cuisine-templates";

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

function isoDateOffset(daysFromToday: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  return d;
}

@Injectable()
export class OnboardingSeedService {
  private readonly logger = new Logger(OnboardingSeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Seed a brand-new company with a template restaurant + categories + items + tables + sample
   *  orders and reservations. All seeded records are flagged isExample=true so the user can wipe
   *  them with one click. Idempotent: aborts if the company already has a restaurant. */
  async seedTemplate(params: {
    companyId: string;
    cuisine: CuisineKey;
    restaurantName: string;
    currency: string;
    locale: string | null | undefined;
  }): Promise<{ restaurantId: string } | null> {
    const { companyId, cuisine, restaurantName, currency } = params;
    const seedLocale = pickSeedLocale(params.locale);
    const template = cuisineTemplates[cuisine];

    const existing = await this.prisma.restaurant.findFirst({
      where: { companyId },
      select: { id: true },
    });
    if (existing) {
      this.logger.log(`Skipping seed for company ${companyId} — restaurant already exists`);
      return null;
    }

    const subtitle = pick(template.subtitle, seedLocale);
    // Always offer English as a secondary language; deduplicate in case seedLocale is en.
    const languages = Array.from(new Set([seedLocale, "en"]));
    const slug = await this.uniqueSlug(restaurantName);
    const description = pick(commonPlaceholders.description, seedLocale);

    return this.prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          companyId,
          title: restaurantName,
          subtitle,
          slug,
          description,
          address: commonPlaceholders.address,
          phone: commonPlaceholders.phone,
          instagram: commonPlaceholders.instagram,
          whatsapp: commonPlaceholders.whatsapp,
          currency,
          languages,
          defaultLanguage: seedLocale,
          ordersEnabled: true,
          reservationsEnabled: true,
          ...(template.backgroundUrl ? { source: template.backgroundUrl, backgroundType: "image" } : {}),
        },
      });

      // Categories — default-lang name + JSON translations across every locale we have content for.
      // Sequential awaits inside a Prisma transaction — Promise.all on the same tx instance
      // can violate isolation guarantees, so loop instead.
      const createdCategories: Array<{ id: string }> = [];
      for (const cat of template.categories) {
        const created = await tx.category.create({
          data: {
            companyId,
            name: pick(cat.name, seedLocale)!,
            translations: buildNameTranslations(cat.name, seedLocale),
            sortOrder: cat.sortOrder,
          },
        });
        createdCategories.push(created);
      }

      // Items — keyed by categoryIndex into createdCategories. Also keep the
      // full multilingual name on the in-memory item so the order-seeding
      // step below can stamp the dashboard-expected dishNameSnapshot.
      const createdItems: Array<{
        id: string;
        name: string;
        price: { toString(): string };
        nameMl: Record<string, string>;
      }> = [];
      for (const item of template.items) {
        const category = createdCategories[item.categoryIndex];
        const nameMl: Record<string, string> = {};
        for (const [lang, value] of Object.entries(item.name)) {
          if (typeof value === "string" && value.length > 0) nameMl[lang] = value;
        }
        const created = await tx.item.create({
          data: {
            companyId,
            categoryId: category.id,
            name: pick(item.name, seedLocale)!,
            description: pick(item.description, seedLocale),
            translations: buildItemTranslations(item.name, item.description, seedLocale),
            price: item.price,
            sortOrder: item.sortOrder,
            isExample: true,
            ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
          },
        });
        createdItems.push({ ...created, nameMl });
      }

      // Tables — three sample tables for the floor map. Pre-position them
      // so they don't pile up at (50,50) the way unplaced tables would, and
      // pre-pick three contrasting colours from the same swatch the dashboard
      // table form offers so the owner sees the colour-coding feature on
      // first load instead of three identical pins.
      const TABLE_SEEDS: Array<{ number: number; capacity: number; x: number; y: number; color: string }> = [
        { number: 1, capacity: 2, x: 25, y: 30, color: "#C8102E" },
        { number: 2, capacity: 4, x: 50, y: 55, color: "#1F5959" },
        { number: 3, capacity: 6, x: 75, y: 30, color: "#D4A017" },
      ];
      const tables: Array<{ id: string; number: number }> = [];
      for (const seed of TABLE_SEEDS) {
        const created = await tx.table.create({
          data: {
            restaurantId: restaurant.id,
            number: seed.number,
            capacity: seed.capacity,
            x: seed.x,
            y: seed.y,
            color: seed.color,
            sortOrder: seed.number - 1,
            isExample: true,
          },
        });
        tables.push(created);
      }

      // Sample orders. Pick a few items from different categories so the order list looks lived-in.
      const guests = sampleGuestNames[seedLocale] ?? sampleGuestNames.en;
      const itemsByCategory = template.categories.map((_, ci) =>
        createdItems.filter((_it, idx) => template.items[idx].categoryIndex === ci),
      );
      const pickItem = (catIdx: number, fallback: number) =>
        itemsByCategory[catIdx]?.[0] ?? createdItems[fallback];

      const orderSamples: Array<{ status: string; itemStatus: "pending" | "cooking" | "ready" | "served"; lines: { item: typeof createdItems[number]; qty: number }[] }> = [
        { status: "new", itemStatus: "pending", lines: [{ item: pickItem(0, 0), qty: 2 }, { item: pickItem(2, 1), qty: 2 }] },
        { status: "in_progress", itemStatus: "cooking", lines: [{ item: pickItem(1, 0), qty: 1 }, { item: pickItem(2, 0), qty: 1 }] },
        { status: "completed", itemStatus: "served", lines: [{ item: pickItem(0, 0), qty: 1 }, { item: pickItem(2, 1), qty: 1 }] },
      ];

      const seedOrderDate = new Date();
      seedOrderDate.setUTCHours(0, 0, 0, 0);
      const nowIso = new Date().toISOString();
      let itemSerial = 0;
      for (let idx = 0; idx < orderSamples.length; idx++) {
        const sample = orderSamples[idx];
        const lines = sample.lines.filter((l) => l.item);
        const total = lines.reduce((sum, l) => sum + Number(l.item.price) * l.qty, 0);
        // The new dashboard renders the "fat" per-unit shape with dishNameSnapshot
        // (Ml object), basePriceSnapshot, options[], and a per-unit status; the
        // legacy soqrmenuweb dashboard still reads the flat { name, qty, price }
        // tuple. Emit both shapes on the same row so either dashboard picks the
        // sample order up correctly.
        const items = lines.flatMap((l) =>
          Array.from({ length: l.qty }, () => {
            itemSerial++;
            const localizedName = l.item.nameMl[seedLocale] || l.item.nameMl.en || l.item.name;
            return {
              id: `seed_${idx}_${itemSerial}`,
              dishId: l.item.id,
              dishNameSnapshot: l.item.nameMl,
              basePriceSnapshot: String(Number(l.item.price)),
              options: [],
              notes: "",
              status: sample.itemStatus,
              createdAt: nowIso,
              // Legacy fields for the old soqrmenuweb dashboard.
              name: localizedName,
              qty: 1,
              price: Number(l.item.price),
            };
          }),
        );
        await tx.order.create({
          data: {
            restaurantId: restaurant.id,
            companyId,
            items,
            total,
            currency,
            customerName: guests[idx % guests.length],
            tableNumber: tables[idx % tables.length].number,
            status: sample.status,
            isExample: true,
            orderDate: seedOrderDate,
            dailyNumber: idx + 1,
          },
        });
      }

      // Sample reservations — one today, one tomorrow.
      const reservationSamples = [
        { dateOffset: 0, startTime: "19:00", guestsCount: 2, tableIdx: 0 },
        { dateOffset: 1, startTime: "20:30", guestsCount: 4, tableIdx: 1 },
      ];

      for (let idx = 0; idx < reservationSamples.length; idx++) {
        const s = reservationSamples[idx];
        await tx.reservation.create({
          data: {
            restaurantId: restaurant.id,
            tableId: tables[s.tableIdx].id,
            date: isoDateOffset(s.dateOffset),
            startTime: s.startTime,
            duration: 90,
            guestName: guests[(idx + 1) % guests.length],
            guestEmail: `guest${idx + 1}@example.com`,
            guestsCount: s.guestsCount,
            status: idx === 0 ? "confirmed" : "pending",
            isExample: true,
          },
        });
      }

      // Mark onboarding complete so the user lands directly in the dashboard,
      // not in the legacy 4-step onboarding wizard.
      await tx.company.update({
        where: { id: companyId },
        data: { onboardingStep: 3 },
      });

      return { restaurantId: restaurant.id };
    });
  }

  /** Mirror RestaurantService.uniqueSlug — kept private to the seeder so it doesn't pull in
   *  the whole restaurant module just for one helper. Always returns a random suffix on
   *  collision (no time-based fallback that could collide between concurrent seeds). */
  private async uniqueSlug(seed: string): Promise<string> {
    const base = (seed || "rest")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "rest";
    let slug = base;
    for (let i = 0; i < 20; i++) {
      const taken = await this.prisma.restaurant.findFirst({ where: { slug }, select: { id: true } });
      if (!taken) return slug;
      // Use a 6-char random suffix so even concurrent collisions are vanishingly unlikely.
      slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    }
    // 20 random suffixes all collided — astronomically unlikely; surface the issue.
    throw new Error(`Could not allocate a unique slug for "${seed}" after 20 attempts`);
  }
}
