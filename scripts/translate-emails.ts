/**
 * Generate src/i18n/<lang>.json from src/i18n/en.json via Gemini.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx tsx scripts/translate-emails.ts            # all langs
 *   GEMINI_API_KEY=... npx tsx scripts/translate-emails.ts de fr ja   # subset
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "src/i18n/en.json");
const OUT_DIR = resolve(ROOT, "src/i18n");

const LANGUAGE_NAMES: Record<string, string> = {
  de: "German", fr: "French", it: "Italian", pt: "Portuguese", nl: "Dutch",
  pl: "Polish", ru: "Russian", uk: "Ukrainian", sv: "Swedish", da: "Danish",
  no: "Norwegian Bokmål", fi: "Finnish", cs: "Czech", el: "Greek", tr: "Turkish",
  ro: "Romanian", hu: "Hungarian", bg: "Bulgarian", hr: "Croatian", sk: "Slovak",
  sl: "Slovenian", et: "Estonian", lv: "Latvian", lt: "Lithuanian", sr: "Serbian (Latin)",
  ca: "Catalan", ga: "Irish", is: "Icelandic", fa: "Persian (Farsi)", ar: "Arabic",
  ja: "Japanese", ko: "Korean", zh: "Simplified Chinese", es: "Spanish",
};

const ALL_LANGS = Object.keys(LANGUAGE_NAMES);
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is required");
  process.exit(1);
}

const argLangs = process.argv.slice(2).filter((s) => !s.startsWith("-"));
const targets = argLangs.length ? argLangs : ALL_LANGS;
const unknown = targets.filter((l) => !LANGUAGE_NAMES[l]);
if (unknown.length) {
  console.error("Unknown locale code(s):", unknown.join(", "));
  process.exit(1);
}

const source = JSON.parse(readFileSync(SRC, "utf8")) as Record<string, unknown>;

const SYSTEM_PROMPT = `
You are a professional translator localising transactional emails and a
default company name for "IQ Rest" — a SaaS dashboard for restaurants and
cafés. Translate the JSON values from English to {LANG}. RULES:

1. Return STRICT JSON with EXACTLY the same shape (same keys / nesting).
   Translate VALUES only.
2. Preserve every ICU placeholder verbatim: "{code}", "{name}", etc.
3. Preserve embedded HTML (<br>, <a>, etc.) unchanged.
4. "companyDefaultName" is the user's restaurant placeholder name shown
   right after signup. Pick a short, neutral phrase that means "My Company"
   or "My Restaurant" in {LANG}. Keep it 2–3 words max.
5. Email tone: friendly, polished SaaS. Brand "IQ Rest" stays untranslated.
6. Numbers / booleans / null returned unchanged.
7. NEVER add commentary or markdown fences. Output raw JSON.
`.trim();

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

function placeholdersOf(s: string): string[] {
  return s.match(/\{[^}]+\}/g)?.sort() ?? [];
}

function placeholdersMatch(en: string, t: string): boolean {
  const a = placeholdersOf(en);
  const b = placeholdersOf(t);
  if (a.length !== b.length) return false;
  return a.every((p, i) => p === b[i]);
}

function validateShape(en: unknown, t: unknown, path = ""): string | null {
  if (typeof en === "string") {
    if (typeof t !== "string") return `${path}: expected string`;
    if (!placeholdersMatch(en, t)) return `${path}: placeholder mismatch (en="${en}" / out="${t}")`;
    return null;
  }
  if (en && typeof en === "object" && !Array.isArray(en)) {
    if (!t || typeof t !== "object") return `${path}: expected object`;
    const enObj = en as Record<string, unknown>;
    const tObj = t as Record<string, unknown>;
    for (const k of Object.keys(enObj)) {
      if (!(k in tObj)) return `${path}.${k}: key missing`;
      const err = validateShape(enObj[k], tObj[k], `${path}.${k}`);
      if (err) return err;
    }
    return null;
  }
  if (en !== t) return `${path}: primitive mismatch`;
  return null;
}

async function translate(langName: string, payload: unknown): Promise<unknown> {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT.replace("{LANG}", langName) }] },
    contents: [
      {
        role: "user",
        parts: [{ text: "Translate to " + langName + ":\n\n" + JSON.stringify(payload, null, 2) }],
      },
    ],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
  };

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey! },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = (await res.json()) as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response");
  const cleaned = text.trim().replace(/^```json\n?/, "").replace(/```$/, "");
  return JSON.parse(cleaned);
}

async function main() {
  console.log(`Translating to ${targets.length} language(s): ${targets.join(", ")}`);
  for (const lang of targets) {
    const langName = LANGUAGE_NAMES[lang];
    const outPath = resolve(OUT_DIR, `${lang}.json`);
    if (existsSync(outPath)) {
      console.log(`  ${lang}: exists, skip`);
      continue;
    }
    process.stdout.write(`  ${lang} (${langName}) … `);
    try {
      const translated = await translate(langName, source);
      const err = validateShape(source, translated);
      if (err) {
        console.log(`SHAPE ERR: ${err}`);
        continue;
      }
      writeFileSync(outPath, JSON.stringify(translated, null, 2) + "\n", "utf8");
      console.log("ok");
    } catch (e) {
      console.log(`FAIL: ${(e as Error).message}`);
    }
  }
  console.log("Done.");
}

void main();
