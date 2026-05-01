export const CUISINE_KEYS = [
  "pizza",
  "sushi",
  "asian",
  "burger",
  "coffee",
  "bar",
  "bakery",
  "restaurant",
] as const;

export type CuisineKey = (typeof CUISINE_KEYS)[number];

export function isCuisineKey(value: unknown): value is CuisineKey {
  return typeof value === "string" && (CUISINE_KEYS as readonly string[]).includes(value);
}
