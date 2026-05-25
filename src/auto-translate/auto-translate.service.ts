import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", de: "German", fr: "French", it: "Italian",
  pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian",
  sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", cs: "Czech",
  el: "Greek", tr: "Turkish", ro: "Romanian", hu: "Hungarian", bg: "Bulgarian",
  hr: "Croatian", sk: "Slovak", sl: "Slovenian", et: "Estonian", lv: "Latvian",
  lt: "Lithuanian", sr: "Serbian", ca: "Catalan", ga: "Irish", is: "Icelandic",
  fa: "Persian", ar: "Arabic", ja: "Japanese", ko: "Korean", zh: "Chinese",
};

type TranslationsMap = Record<string, {
  name?: string | null;
  description?: string | null;
  nameLocked?: boolean;
  descriptionLocked?: boolean;
}>;

// Generic per-lang batch — each entry has a stable key (e.g. "name",
// "description", "opt:<id>:name", "var:<optId>:<varId>:name") and the
// source text to translate. The translator returns a map keyed by the
// same key strings so the caller can distribute results back wherever
// they came from.
interface KeyedSource {
  key: string;
  text: string;
}

type DishOptionLike = {
  id?: string;
  name?: Record<string, string> | null;
  variants?: DishVariantLike[] | null;
  [k: string]: unknown;
};
type DishVariantLike = {
  id?: string;
  name?: Record<string, string> | null;
  [k: string]: unknown;
};

@Injectable()
export class AutoTranslateService {
  private readonly logger = new Logger(AutoTranslateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Auto-translate item name/description into restaurant's additional languages.
   * Fire-and-forget: the caller does not await this, exceptions are swallowed.
   *
   * Per-lang × per-field decision:
   *  - if the field is locked (user manually edited it) — never touch.
   *  - if the source field changed in this save — translate (override).
   *  - if the target translation is empty — translate (fill gap).
   *  - otherwise skip.
   */
  /**
   * Translate one item synchronously. The item endpoint awaits this so the
   * response already contains the freshly-translated translations.
   * Errors are swallowed (logged) — a Gemini hiccup must not break a save.
   */
  async translateItem(opts: {
    companyId: string;
    restaurantId: string;
    itemId: string;
    sourceNameChanged: boolean;
    sourceDescriptionChanged: boolean;
  }) {
    try {
      await this.runItem(opts);
    } catch (err) {
      this.logger.error(`auto-translate item failed: ${err}`);
    }
  }

  async translateCategory(opts: {
    companyId: string;
    restaurantId: string;
    categoryId: string;
    sourceNameChanged: boolean;
  }) {
    try {
      await this.runCategory(opts);
    } catch (err) {
      this.logger.error(`auto-translate category failed: ${err}`);
    }
  }

  /**
   * Walk every item + category in the restaurant, parallelised with a
   * concurrency cap so we don't pelt Gemini all at once. Runs the gap-fill
   * path so newly-added languages get populated. The restaurant settings
   * save awaits this so the UI can keep its blocking modal up.
   */
  async runMenuBackfill(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { companyId: true },
    });
    if (!restaurant) return;
    const [items, cats] = await Promise.all([
      this.prisma.item.findMany({ where: { restaurantId, deletedAt: null }, select: { id: true } }),
      this.prisma.category.findMany({ where: { restaurantId, deletedAt: null }, select: { id: true } }),
    ]);
    await parallelLimit(items, 5, async (it) => {
      try {
        await this.runItem({
          companyId: restaurant.companyId,
          restaurantId,
          itemId: it.id,
          sourceNameChanged: false,
          sourceDescriptionChanged: false,
        });
      } catch (err) {
        this.logger.error(`backfill item ${it.id} failed: ${err}`);
      }
    });
    await parallelLimit(cats, 5, async (c) => {
      try {
        await this.runCategory({
          companyId: restaurant.companyId,
          restaurantId,
          categoryId: c.id,
          sourceNameChanged: false,
        });
      } catch (err) {
        this.logger.error(`backfill category ${c.id} failed: ${err}`);
      }
    });
  }

  /**
   * Drop translations[lang] from every item and category in the restaurant.
   * Used when the user removes a language from restaurant settings.
   */
  async removeLanguagesFromMenu(restaurantId: string, langs: string[]) {
    if (langs.length === 0) return;
    const minusExpr = langs.map((_, i) => `- $${i + 2}`).join(" ");
    const args: (string | string[])[] = [restaurantId, ...langs];
    await this.prisma.$executeRawUnsafe(
      `UPDATE items SET translations = translations ${minusExpr} WHERE "restaurantId" = $1 AND translations IS NOT NULL`,
      ...args,
    );
    await this.prisma.$executeRawUnsafe(
      `UPDATE categories SET translations = translations ${minusExpr} WHERE "restaurantId" = $1 AND translations IS NOT NULL`,
      ...args,
    );
  }

  /**
   * Atomically swap the "source" item.name/description with the translation
   * stored under the new default language. The previous default's value is
   * archived back into translations[oldDefault] so nothing is lost.
   *
   * Without this swap, item.name keeps holding the oldDefault value while
   * the dashboard treats item.name as the defaultLanguage source — every
   * subsequent auto-translate would think the source is in the wrong
   * language.
   */
  async swapMenuDefaultLanguage(restaurantId: string, oldDefault: string, newDefault: string) {
    if (!oldDefault || !newDefault || oldDefault === newDefault) return;

    // Items: archive the previous source into translations[oldDefault] only
    // when that key is missing — otherwise we'd clobber a manual translation
    // (and its lock) the user already typed.
    await this.prisma.$executeRawUnsafe(
      `
      UPDATE items
      SET
        name = COALESCE(translations->$2->>'name', name),
        description = COALESCE(translations->$2->>'description', description),
        translations =
          (COALESCE(translations, '{}'::jsonb) - $2)
          || CASE
               WHEN COALESCE(translations, '{}'::jsonb) ? $3
                 THEN jsonb_build_object($3::text, translations->$3)
               ELSE
                 jsonb_build_object(
                   $3::text,
                   jsonb_build_object(
                     'name', name,
                     'description', description
                   )
                 )
             END
      WHERE "restaurantId" = $1
      `,
      restaurantId,
      newDefault,
      oldDefault,
    );

    // Categories: only name.
    await this.prisma.$executeRawUnsafe(
      `
      UPDATE categories
      SET
        name = COALESCE(translations->$2->>'name', name),
        translations =
          (COALESCE(translations, '{}'::jsonb) - $2)
          || CASE
               WHEN COALESCE(translations, '{}'::jsonb) ? $3
                 THEN jsonb_build_object($3::text, translations->$3)
               ELSE
                 jsonb_build_object(
                   $3::text,
                   jsonb_build_object('name', name)
                 )
             END
      WHERE "restaurantId" = $1
      `,
      restaurantId,
      newDefault,
      oldDefault,
    );
  }

  private async runItem({
    restaurantId,
    itemId,
    sourceNameChanged,
    sourceDescriptionChanged,
  }: {
    companyId: string;
    restaurantId: string;
    itemId: string;
    sourceNameChanged: boolean;
    sourceDescriptionChanged: boolean;
  }) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { defaultLanguage: true, languages: true },
    });
    if (!restaurant) return;
    const defaultLang = restaurant.defaultLanguage;
    const targets = (restaurant.languages || []).filter((l) => l && l !== defaultLang);
    if (targets.length === 0) return;

    const item = await this.prisma.item.findFirst({
      where: { id: itemId, restaurantId, deletedAt: null },
      select: { id: true, name: true, description: true, translations: true, options: true },
    });
    if (!item) return;

    const sourceName = item.name || "";
    const sourceDescription = item.description || "";
    const current = (item.translations as TranslationsMap | null) ?? {};
    const options = normalizeOptionsArray(item.options);

    // Per-language list of {key, source} pairs that need translating.
    // - name/description: gated by lock flag + source-changed / empty target
    // - option/variant names: gated by missing target value (items.service
    //   wipes target langs whenever the default-lang source changes, so the
    //   "target missing" check already covers renames)
    const byLang = new Map<string, KeyedSource[]>();
    for (const lang of targets) {
      const tr = current[lang] || {};
      const reqs: KeyedSource[] = [];
      if (sourceName && !tr.nameLocked && (sourceNameChanged || !tr.name)) {
        reqs.push({ key: "name", text: sourceName });
      }
      if (sourceDescription && !tr.descriptionLocked && (sourceDescriptionChanged || !tr.description)) {
        reqs.push({ key: "description", text: sourceDescription });
      }
      for (const opt of options) {
        if (!opt.id) continue;
        const optDefault = opt.name?.[defaultLang]?.trim() || "";
        if (optDefault && !(opt.name?.[lang] || "").trim()) {
          reqs.push({ key: `opt:${opt.id}:name`, text: optDefault });
        }
        const variants = Array.isArray(opt.variants) ? opt.variants : [];
        for (const v of variants) {
          if (!v.id) continue;
          const vDefault = v.name?.[defaultLang]?.trim() || "";
          if (vDefault && !(v.name?.[lang] || "").trim()) {
            reqs.push({ key: `var:${opt.id}:${v.id}:name`, text: vDefault });
          }
        }
      }
      if (reqs.length > 0) byLang.set(lang, reqs);
    }
    if (byLang.size === 0) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return;

    // Fan out: one Gemini call per language, all in parallel. Each call
    // carries the entire set of strings for that language (name +
    // description + every option/variant name) so the wall-clock equals one
    // Gemini round-trip regardless of how many strings the dish has.
    const results = new Map<string, Map<string, string>>();
    await Promise.all(
      Array.from(byLang.entries()).map(async ([lang, reqs]) => {
        const out = await this.translateKeyedBatch(apiKey, lang, reqs);
        if (out && out.size > 0) results.set(lang, out);
      }),
    );
    if (results.size === 0) return;

    // Re-read the freshest row so we merge with anything the user may have
    // saved while Gemini was thinking (manual edits win for fields we did
    // not translate).
    const fresh = await this.prisma.item.findFirst({
      where: { id: itemId, restaurantId, deletedAt: null },
      select: { id: true, translations: true, options: true },
    });
    if (!fresh) return;

    const mergedTranslations: TranslationsMap = { ...((fresh.translations as TranslationsMap | null) ?? {}) };
    const mergedOptions = normalizeOptionsArray(fresh.options);

    for (const [lang, kvs] of results) {
      const existing = mergedTranslations[lang] || {};
      const next: TranslationsMap[string] = { ...existing };
      let touchedTranslations = false;

      for (const [key, value] of kvs) {
        if (key === "name") {
          next.name = value;
          touchedTranslations = true;
          continue;
        }
        if (key === "description") {
          next.description = value;
          touchedTranslations = true;
          continue;
        }
        const optMatch = key.match(/^opt:(.+):name$/);
        if (optMatch && !key.startsWith("var:")) {
          const optId = optMatch[1];
          const opt = mergedOptions.find((o) => o.id === optId);
          if (opt && !(opt.name?.[lang] || "").trim()) {
            opt.name = { ...(opt.name || {}), [lang]: value };
          }
          continue;
        }
        const varMatch = key.match(/^var:([^:]+):(.+):name$/);
        if (varMatch) {
          const [, optId, varId] = varMatch;
          const opt = mergedOptions.find((o) => o.id === optId);
          const v = opt?.variants?.find?.((x) => x.id === varId);
          if (v && !(v.name?.[lang] || "").trim()) {
            v.name = { ...(v.name || {}), [lang]: value };
          }
        }
      }
      if (touchedTranslations) mergedTranslations[lang] = next;
    }

    await this.prisma.item.update({
      where: { id: fresh.id },
      data: {
        translations: mergedTranslations as Prisma.InputJsonValue,
        options: mergedOptions as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async runCategory({
    restaurantId,
    categoryId,
    sourceNameChanged,
  }: {
    companyId: string;
    restaurantId: string;
    categoryId: string;
    sourceNameChanged: boolean;
  }) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { defaultLanguage: true, languages: true },
    });
    if (!restaurant) return;
    const targets = (restaurant.languages || []).filter((l) => l && l !== restaurant.defaultLanguage);
    if (targets.length === 0) return;

    const cat = await this.prisma.category.findFirst({
      where: { id: categoryId, restaurantId },
      select: { id: true, name: true, translations: true },
    });
    if (!cat) return;

    const sourceName = cat.name || "";
    if (!sourceName) return;
    const current = (cat.translations as TranslationsMap | null) ?? {};

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return;

    const todo: { lang: string; reqs: KeyedSource[] }[] = [];
    for (const lang of targets) {
      const tr = current[lang] || {};
      if (!tr.nameLocked && (sourceNameChanged || !tr.name)) {
        todo.push({ lang, reqs: [{ key: "name", text: sourceName }] });
      }
    }
    if (todo.length === 0) return;

    const results = new Map<string, Map<string, string>>();
    await Promise.all(
      todo.map(async ({ lang, reqs }) => {
        const out = await this.translateKeyedBatch(apiKey, lang, reqs);
        if (out && out.size > 0) results.set(lang, out);
      }),
    );
    if (results.size === 0) return;

    const fresh = await this.prisma.category.findFirst({
      where: { id: categoryId, restaurantId },
      select: { id: true, translations: true },
    });
    if (!fresh) return;

    const merged: TranslationsMap = { ...((fresh.translations as TranslationsMap | null) ?? {}) };
    for (const [lang, kvs] of results) {
      const existing = merged[lang] || {};
      const name = kvs.get("name");
      if (name !== undefined) merged[lang] = { ...existing, name };
    }

    await this.prisma.category.update({
      where: { id: fresh.id },
      data: { translations: merged as Prisma.InputJsonValue },
    });
  }

  /**
   * Translate a batch of keyed strings into a single target language. Each
   * call returns a Map<key, translated> so the caller can stitch results
   * back wherever they came from (name/description/options/variants). All
   * target languages run in parallel — Gemini-2.5-flash on Tier 1 easily
   * absorbs the 34 concurrent calls a typical dish save produces, so we no
   * longer impose a wall-clock penalty by capping concurrency.
   */
  private async translateKeyedBatch(
    apiKey: string,
    lang: string,
    items: KeyedSource[],
  ): Promise<Map<string, string> | null> {
    if (items.length === 0) return null;

    const ln = LANGUAGE_NAMES[lang] || lang;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const sources: Record<string, string> = {};
    for (const it of items) {
      properties[it.key] = { type: "string" };
      required.push(it.key);
      sources[it.key] = it.text;
    }

    const prompt = [
      `You are a strict literal translator for restaurant menus. Translate every value in the JSON below into ${ln} (${lang}).`,
      "Each key holds an independent short string (dish name, dish description, option group name, or variant name).",
      "Hard rules:",
      "- Translate ONLY what is in the source. Do NOT add adjectives, descriptions, or commentary that is not in the original.",
      "- Do NOT make the text more appetizing or marketing-y.",
      "- Preserve dish names, brand names, and proper nouns as-is when they have no standard translation.",
      "- Preserve numbers, units, allergen codes, HTML/markdown markers verbatim.",
      "- Match the source length and structure as closely as the target language allows.",
      "- If the source is just a name (no description), output just the translated name — never invent a description.",
      "- Output ONLY the final translated text for each field. No alternatives, no 'or X', no parenthetical notes, no explanations, no reasoning, no 'depending on...'. One value per field, nothing else.",
      "",
      `Source: ${JSON.stringify(sources)}`,
      "",
      "Output JSON with exactly the same keys as the source.",
    ].join("\n");

    // Cap output tokens at ~80 per string (rough upper bound for a dish
    // name/description after worst-case Cyrillic expansion). The previous
    // hard-coded 2000 made every dish — including 1-field categories — pay
    // the full budget.
    const maxOutputTokens = Math.min(8000, 256 + items.length * 96);

    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.1,
                maxOutputTokens,
                responseMimeType: "application/json",
                responseSchema: {
                  type: "object",
                  properties,
                  required,
                },
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
          },
        );

        if (res.status === 429 || res.status >= 500) {
          // Halved the retry backoff from 500ms — Gemini almost always
          // recovers on the first retry, and the user is waiting on this
          // call synchronously, so eat less wall-clock on a transient.
          await sleep(250 * Math.pow(2, attempt));
          lastErr = new Error(`Gemini ${res.status}`);
          continue;
        }

        if (!res.ok) {
          const txt = await res.text();
          this.logger.error(`Gemini ${res.status} (${lang}): ${txt.slice(0, 300)}`);
          return null;
        }

        const data = (await res.json()) as {
          candidates?: {
            content?: { parts?: { text?: string }[] };
            finishReason?: string;
          }[];
        };
        const candidate = data.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text;
        if (candidate?.finishReason && candidate.finishReason !== "STOP") {
          this.logger.error(
            `Gemini (${lang}) finishReason=${candidate.finishReason} — likely truncated`,
          );
        }
        if (!text) return null;
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const out = new Map<string, string>();
          for (const k of Object.keys(sources)) {
            const v = parsed[k];
            if (typeof v === "string" && v.length > 0) out.set(k, v);
          }
          return out;
        } catch (err) {
          this.logger.error(
            `Gemini (${lang}) invalid JSON: ${err}; text head: ${text.slice(0, 200)}`,
          );
          return null;
        }
      } catch (err) {
        lastErr = err;
        await sleep(250 * Math.pow(2, attempt));
      }
    }
    this.logger.error(`Gemini (${lang}) all retries failed: ${lastErr}`);
    return null;
  }
}

// Convert the JSON-blob `Item.options` column into a typed array. Returns a
// deep-enough copy so callers can mutate `name[lang]` slots without
// touching the original Prisma row.
function normalizeOptionsArray(raw: unknown): DishOptionLike[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const opt = (o ?? {}) as DishOptionLike;
    const variants = Array.isArray(opt.variants)
      ? opt.variants.map((v) => {
          const vv = (v ?? {}) as DishVariantLike;
          return { ...vv, name: vv.name ? { ...vv.name } : null } as DishVariantLike;
        })
      : null;
    return { ...opt, name: opt.name ? { ...opt.name } : null, variants } as DishOptionLike;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parallelLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      await fn(next);
    }
  });
  await Promise.all(workers);
}
