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

interface TranslateRequest {
  lang: string;
  fields: { name?: string; description?: string };
}

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
   * Walk every item + category in the company, parallelised with a
   * concurrency cap so we don't pelt Gemini all at once. Runs the gap-fill
   * path so newly-added languages get populated. The restaurant settings
   * save awaits this so the UI can keep its blocking modal up.
   */
  async runMenuBackfill(companyId: string) {
    const [items, cats] = await Promise.all([
      this.prisma.item.findMany({ where: { companyId }, select: { id: true } }),
      this.prisma.category.findMany({ where: { companyId }, select: { id: true } }),
    ]);
    await parallelLimit(items, 5, async (it) => {
      try {
        await this.runItem({
          companyId,
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
          companyId,
          categoryId: c.id,
          sourceNameChanged: false,
        });
      } catch (err) {
        this.logger.error(`backfill category ${c.id} failed: ${err}`);
      }
    });
  }

  /**
   * Drop translations[lang] from every item and category in the company. Used
   * when the user removes a language from restaurant settings.
   */
  async removeLanguagesFromMenu(companyId: string, langs: string[]) {
    if (langs.length === 0) return;
    // Build chained jsonb minus expression: translations - 'a' - 'b' - ...
    const minusExpr = langs.map((_, i) => `- $${i + 2}`).join(" ");
    const args: (string | string[])[] = [companyId, ...langs];
    await this.prisma.$executeRawUnsafe(
      `UPDATE items SET translations = translations ${minusExpr} WHERE "companyId" = $1 AND translations IS NOT NULL`,
      ...args,
    );
    await this.prisma.$executeRawUnsafe(
      `UPDATE categories SET translations = translations ${minusExpr} WHERE "companyId" = $1 AND translations IS NOT NULL`,
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
  async swapMenuDefaultLanguage(companyId: string, oldDefault: string, newDefault: string) {
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
      WHERE "companyId" = $1
      `,
      companyId,
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
      WHERE "companyId" = $1
      `,
      companyId,
      newDefault,
      oldDefault,
    );
  }

  private async runItem({
    companyId,
    itemId,
    sourceNameChanged,
    sourceDescriptionChanged,
  }: {
    companyId: string;
    itemId: string;
    sourceNameChanged: boolean;
    sourceDescriptionChanged: boolean;
  }) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { companyId },
      select: { defaultLanguage: true, languages: true },
    });
    if (!restaurant) return;
    const targets = (restaurant.languages || []).filter((l) => l && l !== restaurant.defaultLanguage);
    if (targets.length === 0) return;

    const item = await this.prisma.item.findFirst({
      where: { id: itemId, companyId },
      select: { id: true, name: true, description: true, translations: true },
    });
    if (!item) return;

    const sourceName = item.name || "";
    const sourceDescription = item.description || "";
    const current = (item.translations as TranslationsMap | null) ?? {};

    const requests: TranslateRequest[] = [];
    for (const lang of targets) {
      const tr = current[lang] || {};
      const fields: { name?: string; description?: string } = {};
      // name: skip if locked; otherwise translate when source changed or empty
      if (sourceName && !tr.nameLocked && (sourceNameChanged || !tr.name)) {
        fields.name = sourceName;
      }
      if (sourceDescription && !tr.descriptionLocked && (sourceDescriptionChanged || !tr.description)) {
        fields.description = sourceDescription;
      }
      if (fields.name || fields.description) requests.push({ lang, fields });
    }
    if (requests.length === 0) return;

    const results = await this.translateBatch(requests);
    if (Object.keys(results).length === 0) return;

    // Re-fetch the latest row to merge with whatever the user has saved in
    // the meantime (translations the user typed manually win — we only fill
    // the languages we actually translated).
    const fresh = await this.prisma.item.findFirst({
      where: { id: itemId, companyId },
      select: { id: true, translations: true },
    });
    if (!fresh) return;

    const merged: TranslationsMap = { ...((fresh.translations as TranslationsMap | null) ?? {}) };
    for (const [lang, fields] of Object.entries(results)) {
      const existing = merged[lang] || {};
      merged[lang] = {
        ...existing,
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
      };
    }

    await this.prisma.item.update({
      where: { id: fresh.id },
      data: { translations: merged as Prisma.InputJsonValue },
    });
  }

  private async runCategory({
    companyId,
    categoryId,
    sourceNameChanged,
  }: {
    companyId: string;
    categoryId: string;
    sourceNameChanged: boolean;
  }) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { companyId },
      select: { defaultLanguage: true, languages: true },
    });
    if (!restaurant) return;
    const targets = (restaurant.languages || []).filter((l) => l && l !== restaurant.defaultLanguage);
    if (targets.length === 0) return;

    const cat = await this.prisma.category.findFirst({
      where: { id: categoryId, companyId },
      select: { id: true, name: true, translations: true },
    });
    if (!cat) return;

    const sourceName = cat.name || "";
    if (!sourceName) return;
    const current = (cat.translations as TranslationsMap | null) ?? {};

    const requests: TranslateRequest[] = [];
    for (const lang of targets) {
      const tr = current[lang] || {};
      if (!tr.nameLocked && (sourceNameChanged || !tr.name)) {
        requests.push({ lang, fields: { name: sourceName } });
      }
    }
    if (requests.length === 0) return;

    const results = await this.translateBatch(requests);
    if (Object.keys(results).length === 0) return;

    const fresh = await this.prisma.category.findFirst({
      where: { id: categoryId, companyId },
      select: { id: true, translations: true },
    });
    if (!fresh) return;

    const merged: TranslationsMap = { ...((fresh.translations as TranslationsMap | null) ?? {}) };
    for (const [lang, fields] of Object.entries(results)) {
      const existing = merged[lang] || {};
      merged[lang] = {
        ...existing,
        ...(fields.name !== undefined ? { name: fields.name } : {}),
      };
    }

    await this.prisma.category.update({
      where: { id: fresh.id },
      data: { translations: merged as Prisma.InputJsonValue },
    });
  }

  /**
   * Single Gemini call — translate `fields` for every target language and
   * return a parsed JSON map. Uses Gemini's structured output mode so we
   * don't have to chase markdown/JSON-fence quirks.
   */
  private async translateBatch(
    requests: TranslateRequest[],
  ): Promise<Record<string, { name?: string; description?: string }>> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return {};

    const langInstructions = requests
      .map((r) => {
        const ln = LANGUAGE_NAMES[r.lang] || r.lang;
        const need: string[] = [];
        if (r.fields.name) need.push("name");
        if (r.fields.description) need.push("description");
        return `- ${r.lang} (${ln}): ${need.join(", ")}`;
      })
      .join("\n");

    const sourceBlock = JSON.stringify({
      name: requests[0].fields.name ?? null,
      description: requests[0].fields.description ?? null,
    });

    const sources: { name?: string; description?: string } = {};
    for (const r of requests) {
      if (r.fields.name && !sources.name) sources.name = r.fields.name;
      if (r.fields.description && !sources.description) sources.description = r.fields.description;
    }

    const properties: Record<string, unknown> = {};
    for (const r of requests) {
      const fieldProps: Record<string, unknown> = {};
      if (r.fields.name !== undefined) fieldProps.name = { type: "string" };
      if (r.fields.description !== undefined) fieldProps.description = { type: "string" };
      properties[r.lang] = {
        type: "object",
        properties: fieldProps,
      };
    }

    const prompt = [
      "You are a strict literal translator for restaurant menus.",
      "Translate the given fields into the requested target languages.",
      "Hard rules:",
      "- Translate ONLY what is in the source. Do NOT add adjectives, descriptions, or commentary that is not in the original.",
      "- Do NOT make the text more appetizing or marketing-y.",
      "- Preserve dish names, brand names, and proper nouns as-is when they have no standard translation.",
      "- Preserve numbers, units, allergen codes, HTML/markdown markers verbatim.",
      "- Match the source length and structure as closely as the target language allows.",
      "- If the source is just a name (no description), output just the translated name — never invent a description.",
      "Languages and required fields:",
      langInstructions,
      "",
      `Source (in the restaurant's default language): ${JSON.stringify(sources)}`,
      "",
      "Return strict JSON keyed by language code, matching the requested fields per language.",
    ].join("\n");

    let res: Response;
    try {
      res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 4000,
              responseMimeType: "application/json",
              responseSchema: {
                type: "object",
                properties,
              },
            },
          }),
        },
      );
    } catch (err) {
      this.logger.error(`Gemini fetch failed: ${err}`);
      return {};
    }

    if (!res.ok) {
      const txt = await res.text();
      this.logger.error(`Gemini ${res.status}: ${txt.slice(0, 300)}`);
      return {};
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as Record<string, { name?: string; description?: string }>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      this.logger.error(`Gemini returned invalid JSON: ${err}`);
      return {};
    }
    void sourceBlock;
  }
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
