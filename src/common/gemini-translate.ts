// Thin Gemini translation helper reused by the inbox (incoming → Russian,
// outgoing Russian → contact language). Mirrors the model/config used by the
// dashboard's /translate endpoint.

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", de: "German", fr: "French", it: "Italian",
  pt: "Portuguese", nl: "Dutch", pl: "Polish", ru: "Russian", uk: "Ukrainian",
  sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", cs: "Czech",
  el: "Greek", tr: "Turkish", ro: "Romanian", hu: "Hungarian", bg: "Bulgarian",
  hr: "Croatian", sk: "Slovak", sl: "Slovenian", et: "Estonian", lv: "Latvian",
  lt: "Lithuanian", sr: "Serbian", ca: "Catalan", ga: "Irish", is: "Icelandic",
  fa: "Persian", ar: "Arabic", ja: "Japanese", ko: "Korean", zh: "Chinese",
};

export function languageName(code: string | null | undefined): string {
  if (!code) return "the source language";
  return LANGUAGE_NAMES[code] || code;
}

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function callGemini(system: string, user: string, maxTokens = 600): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

/** Translate `text` into `targetLang` (optionally from a known `sourceLang`). */
export async function translateText(
  text: string,
  targetLang: string,
  sourceLang?: string | null,
): Promise<string> {
  const system =
    `You are a professional chat translator. Translate the user's message from ` +
    `${languageName(sourceLang)} to ${languageName(targetLang)}. Return ONLY the ` +
    `translated text, preserving tone and any emoji. Do not add quotes or notes.`;
  return callGemini(system, text);
}

/** Detect the source language and translate the message to Russian in one call.
 *  Returns the BCP-47-ish 2-letter code we recognise (best effort) + the RU text. */
export async function detectAndTranslateToRu(
  text: string,
): Promise<{ lang: string | null; ru: string }> {
  const system =
    `You translate inbound chat messages to Russian. Detect the source language ` +
    `and return STRICT JSON: {"lang":"<ISO 639-1 code>","ru":"<Russian translation>"}. ` +
    `No markdown, no extra keys. Preserve tone and emoji in the translation.`;
  const raw = await callGemini(system, text);
  try {
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { lang?: string; ru?: string };
    const lang = parsed.lang && LANGUAGE_NAMES[parsed.lang] ? parsed.lang : null;
    return { lang, ru: parsed.ru?.trim() || text };
  } catch {
    // If the model didn't return clean JSON, treat the whole output as the RU text.
    return { lang: null, ru: raw };
  }
}
