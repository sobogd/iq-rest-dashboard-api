import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { isSupportedCurrency } from "../common/stripe";
import type { CuisineKey } from "./cuisine";
import { cuisineTemplates, commonPlaceholders, sampleGuestNames, type LocaleString } from "./cuisine-templates";
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

  /** Seed a brand-new user with a template restaurant + categories + items + tables + sample
   *  reservations. Sample dishes are named "Sample: …" so the owner can spot and replace them
   *  (no sample orders — they would skew revenue analytics). Idempotent: aborts if the user
   *  already has an attached restaurant.
   *
   *  The new restaurant is the user's FIRST → it gets a fresh 14-day trial.
   *  Subsequent restaurants (created via restaurant.controller.createForCompany)
   *  start FREE without a trial. */
  async seedTemplate(params: {
    userId: string;
    cuisine: CuisineKey;
    restaurantName: string;
    currency: string;
    locale: string | null | undefined;
  }): Promise<{ restaurantId: string } | null> {
    const { userId, cuisine, restaurantName, currency } = params;
    const seedLocale = pickSeedLocale(params.locale);
    const template = cuisineTemplates[cuisine];

    const existing = await this.prisma.restaurantUser.findFirst({
      where: { userId },
      select: { restaurantId: true },
    });
    if (existing) {
      this.logger.log(`Skipping seed for user ${userId} — restaurant already attached`);
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
          title: restaurantName,
          subtitle,
          slug,
          description,
          address: commonPlaceholders.address,
          phone: commonPlaceholders.phone,
          instagram: commonPlaceholders.instagram,
          whatsapp: commonPlaceholders.whatsapp,
          currency,
          // Billing currency: the Scandinavian menu currencies (NOK/SEK/DKK)
          // double as billing currencies; everything else bills in EUR.
          billingCurrency: isSupportedCurrency(currency) ? currency : "EUR",
          // Dark accent by default for newly onboarded restaurants.
          accentColor: "#1A1A1A",
          languages,
          defaultLanguage: seedLocale,
          // Orders are off by default now; the owner enables them in settings.
          // Reservations stay on. Sample orders/reservations are still seeded.
          ordersEnabled: false,
          reservationsEnabled: true,
          ...(template.backgroundUrl ? { source: template.backgroundUrl, backgroundType: "image" } : {}),
          // FIRST restaurant of the account → 14-day trial. Subsequent ones
          // (createForCompany) start with no trial.
          plan: "FREE",
          subscriptionStatus: "INACTIVE",
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });

      // Link the seeding user to the new restaurant via the flat access model.
      // addedBy is null for the FIRST user of a restaurant (the creator).
      await tx.restaurantUser.create({
        data: {
          restaurantId: restaurant.id,
          userId,
          addedBy: null,
        },
      });

      // Categories — default-lang name + JSON translations across every locale we have content for.
      // Sequential awaits inside a Prisma transaction — Promise.all on the same tx instance
      // can violate isolation guarantees, so loop instead.
      const createdCategories: Array<{ id: string }> = [];
      for (const cat of template.categories) {
        const created = await tx.category.create({
          data: {
            restaurantId: restaurant.id,
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
        // Prefix every sample dish with "Sample: " so the owner can spot (and
        // replace/delete) the seeded items at a glance — this replaces the old
        // isExample flag as the way to mark seeded content.
        const sampleName: LocaleString = {} as LocaleString;
        const nameMl: Record<string, string> = {};
        for (const [lang, value] of Object.entries(item.name)) {
          if (typeof value === "string" && value.length > 0) {
            sampleName[lang] = `Sample: ${value}`;
            nameMl[lang] = sampleName[lang];
          }
        }
        const created = await tx.item.create({
          data: {
            restaurantId: restaurant.id,
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
          },
        });
        tables.push(created);
      }

      // Sample orders are intentionally NOT seeded — they would otherwise count
      // toward the new restaurant's revenue analytics. Sample reservations and
      // tables stay (they don't affect revenue).
      const guests = sampleGuestNames[seedLocale] ?? sampleGuestNames.en;

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
          },
        });
      }

      return { restaurantId: restaurant.id };
    });
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
