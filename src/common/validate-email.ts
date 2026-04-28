/**
 * Strict email validation. Returns the normalized (lower-cased trimmed)
 * email when valid, or null otherwise.
 */
export function validateEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length < 6 || trimmed.length > 200) return null;
  // Simple but reasonable RFC-leaning regex.
  const re = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
  return re.test(trimmed) ? trimmed : null;
}
