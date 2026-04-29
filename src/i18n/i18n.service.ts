import { Injectable } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Bundle {
  companyDefaultName: string;
  otpEmail: { subject: string; greeting: string; intro: string; expiry: string };
  supportEmail: { subject: string; greeting: string; body: string; cta: string; signature: string };
}

const RTL_LOCALES = new Set(["ar", "fa"]);

const SUPPORTED = [
  "en", "es", "de", "fr", "it", "pt", "nl", "pl", "ru", "uk",
  "sv", "da", "no", "fi", "cs", "el", "tr", "ro", "hu", "bg",
  "hr", "sk", "sl", "et", "lv", "lt", "sr", "ca", "ga", "is",
  "fa", "ar", "ja", "ko", "zh",
];

function normalize(locale: string | null | undefined): string {
  if (!locale) return "en";
  const short = locale.toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.includes(short) ? short : "en";
}

function loadBundle(locale: string): Bundle {
  // dist/i18n.service.js sits one level under dist/, JSON files live next to it.
  // Try the compiled-runtime path first; fall back to source path for tests.
  const candidates = [
    resolve(__dirname, `${locale}.json`),
    resolve(__dirname, "..", "..", "src", "i18n", `${locale}.json`),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Bundle;
    } catch {
      // keep trying
    }
  }
  // English is bundled with the app — if that fails something is very wrong.
  if (locale !== "en") return loadBundle("en");
  throw new Error("English i18n bundle missing");
}

const cache = new Map<string, Bundle>();

@Injectable()
export class I18nService {
  bundle(locale: string | null | undefined): Bundle {
    const lng = normalize(locale);
    let b = cache.get(lng);
    if (!b) {
      b = loadBundle(lng);
      cache.set(lng, b);
    }
    return b;
  }

  isRtl(locale: string | null | undefined): boolean {
    return RTL_LOCALES.has(normalize(locale));
  }

  /** Format the URL locale segment for legacy app URLs. */
  urlLocale(locale: string | null | undefined): string {
    return normalize(locale);
  }
}
