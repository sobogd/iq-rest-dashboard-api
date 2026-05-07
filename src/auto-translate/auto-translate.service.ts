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
  scheduleItem(opts: {
    companyId: string;
    itemId: string;
    sourceNameChanged: boolean;
    sourceDescriptionChanged: boolean;
  }) {
    setImmediate(() => {
      this.runItem(opts).catch((err) => this.logger.error(`auto-translate item failed: ${err}`));
    });
  }

  scheduleCategory(opts: {
    companyId: string;
    categoryId: string;
    sourceNameChanged: boolean;
  }) {
    setImmediate(() => {
      this.runCategory(opts).catch((err) => this.logger.error(`auto-translate category failed: ${err}`));
    });
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
      "You are a professional menu translator.",
      "Translate the given menu item fields into the requested languages.",
      "Keep the tone and style. Make it sound natural and appetizing.",
      "Do not translate or modify any HTML/markdown markers, allergen codes, or numbers.",
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
              temperature: 0.3,
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
