// Onboarding now seeds a single universal template, so there is just one key.
// (The landing's cuisine-picker step is currently skipped — see the create-flow
// register mode. Kept as an array/type so the rest of the pipeline is unchanged.)
export const CUISINE_KEYS = ["restaurant"] as const;

export type CuisineKey = (typeof CUISINE_KEYS)[number];

export function isCuisineKey(value: unknown): value is CuisineKey {
  return typeof value === "string" && (CUISINE_KEYS as readonly string[]).includes(value);
}
