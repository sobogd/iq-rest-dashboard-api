import type { Request } from "express";
import { getCurrencyByCountry, type SupportedCurrency } from "./stripe";

/**
 * Country resolution mirrors the original Next.js middleware:
 *   1. URL query param `?country=XX` (manual override, two letters)
 *   2. Cloudflare `cf-ipcountry` request header
 * No IP-based geo lookup — Cloudflare is the source of truth in production.
 */
export function getRequestCountry(req: Request): string | null {
  const urlCountry =
    typeof req.query?.country === "string" ? req.query.country.toUpperCase() : null;
  if (urlCountry && /^[A-Z]{2}$/.test(urlCountry)) return urlCountry;

  const cf = req.headers["cf-ipcountry"];
  if (typeof cf === "string" && /^[A-Za-z]{2}$/.test(cf)) return cf.toUpperCase();

  return null;
}

export function getRequestCurrency(req: Request): SupportedCurrency {
  return getCurrencyByCountry(getRequestCountry(req));
}
