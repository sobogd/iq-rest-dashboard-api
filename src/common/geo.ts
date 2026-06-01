import type { Request } from "express";
import { getCurrencyByCountry, isSupportedCurrency, type SupportedCurrency } from "./stripe";
import { getMenuCurrencyByCountry } from "./menu-currency";

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

/** Public-menu currency for a new restaurant — broad, geo-based, any ISO code. */
export function getRequestCurrency(req: Request): string {
  return getMenuCurrencyByCountry(getRequestCountry(req));
}

/** IQ Rest billing currency (EUR/NOK/SEK/DKK). Priority:
 *   1. nginx-injected `x-currency` header (GeoIP2 map) or `geo_currency` cookie
 *   2. country → billing-currency map
 * Always one of SUPPORTED_CURRENCIES; defaults to EUR. */
export function getRequestBillingCurrency(req: Request): SupportedCurrency {
  const header = req.headers["x-currency"];
  if (typeof header === "string" && isSupportedCurrency(header.toUpperCase())) {
    return header.toUpperCase() as SupportedCurrency;
  }
  const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const m = /(?:^|;\s*)geo_currency=([^;]+)/.exec(cookie);
  if (m && isSupportedCurrency(decodeURIComponent(m[1]).toUpperCase())) {
    return decodeURIComponent(m[1]).toUpperCase() as SupportedCurrency;
  }
  return getCurrencyByCountry(getRequestCountry(req));
}
