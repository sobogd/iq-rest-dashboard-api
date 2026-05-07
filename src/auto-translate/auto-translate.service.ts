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
   * Translate `fields` into every target language. Splits into one Gemini
   * call per language (sequential within an item) so a long description
   * with many target languages does not bust the per-call token budget —
   * the previous all-langs-in-one-response design silently dropped items
   * whose JSON output got truncated past `maxOutputTokens`. Per-lang calls
   * also let one language fail without losing the rest, and let us retry
   * 429/5xx independently.
   */
  private async translateBatch(
    requests: TranslateRequest[],
  ): Promise<Record<string, { name?: string; description?: string }>> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return {};

    const out: Record<string, { name?: string; description?: string }> = {};
    for (const req of requests) {
      const single = await this.translateOne(apiKey, req);
      if (single) out[req.lang] = single;
    }
    return out;
  }

  private async translateOne(
    apiKey: string,
    req: TranslateRequest,
  ): Promise<{ name?: string; description?: string } | null> {
    const ln = LANGUAGE_NAMES[req.lang] || req.lang;

    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (req.fields.name !== undefined) {
      properties.name = { type: "string" };
      required.push("name");
    }
    if (req.fields.description !== undefined) {
      properties.description = { type: "string" };
      required.push("description");
    }

    const sources: Record<string, string> = {};
    if (req.fields.name !== undefined) sources.name = req.fields.name ?? "";
    if (req.fields.description !== undefined) sources.description = req.fields.description ?? "";

    const prompt = [
      `You are a strict literal translator for restaurant menus. Translate the JSON below into ${ln} (${req.lang}).`,
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
                maxOutputTokens: 2000,
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
          await sleep(500 * Math.pow(2, attempt));
          lastErr = new Error(`Gemini ${res.status}`);
          continue;
        }

        if (!res.ok) {
          const txt = await res.text();
          this.logger.error(`Gemini ${res.status} (${req.lang}): ${txt.slice(0, 300)}`);
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
            `Gemini (${req.lang}) finishReason=${candidate.finishReason} — likely truncated`,
          );
        }
        if (!text) return null;
        try {
          return JSON.parse(text) as { name?: string; description?: string };
        } catch (err) {
          this.logger.error(
            `Gemini (${req.lang}) invalid JSON: ${err}; text head: ${text.slice(0, 200)}`,
          );
          return null;
        }
      } catch (err) {
        lastErr = err;
        await sleep(500 * Math.pow(2, attempt));
      }
    }
    this.logger.error(`Gemini (${req.lang}) all retries failed: ${lastErr}`);
    return null;
  }
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
