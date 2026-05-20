// Slugs that must never be assigned to a restaurant — they collide with
// reserved subdomains, infrastructure paths, or generic words that would
// confuse the public-menu router (e.g. /m/test should not resolve to a real
// tenant). Update both this file and `soqrmenuweb/lib/reserved-slugs.ts`
// in lockstep — the landing form pre-validates client-side, the API
// re-checks server-side, and the onboarding seeder auto-suffixes when a
// reserved value would have been produced.

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // infra / dns
  "www", "ftp", "smtp", "mail", "email", "ns", "ns1", "ns2", "mx",
  "cdn", "static", "assets", "media", "img", "images", "video", "videos",
  "ws", "wss", "api", "auth", "oauth", "sso", "id", "login", "logout",
  "signup", "signin", "otp", "register", "verify",

  // application areas
  "admin", "administrator", "root", "system", "internal", "private",
  "public", "app", "dashboard", "panel", "console", "settings", "config",
  "profile", "account", "accounts", "billing", "subscription", "checkout",
  "support", "help", "contact", "feedback", "tickets", "integrations",
  "analytics", "reports", "stats", "events", "search", "explore",
  "notifications", "messages", "inbox",

  // marketing pages already in use
  "about", "pricing", "terms", "privacy", "cookies", "legal", "careers",
  "jobs", "press", "news", "blog", "changelog", "roadmap", "status",
  "docs", "documentation", "guide", "guides", "tutorial", "tutorials",
  "demo", "examples", "showcase", "partners", "affiliates",

  // environments / non-prod placeholders
  "dev", "develop", "development", "stage", "staging", "prod",
  "production", "beta", "alpha", "sandbox", "qa", "ci", "preview",
  "next", "old", "new", "tmp", "temp", "draft", "trial",

  // generic placeholder values users tend to type when "just trying it"
  "test", "tests", "testing", "example", "sample", "lorem", "demo1",
  "foo", "bar", "baz", "qux", "todo", "asdf", "qwerty", "123",
  "name", "menu", "restaurant", "rest", "untitled", "default", "null",
  "undefined", "owner", "user", "users",

  // public-menu reserved paths
  "m", "qr", "scan", "schema", "sitemap", "robots", "manifest", "favicon",
  "og", "well-known",
]);

export function isReservedSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return RESERVED_SLUGS.has(slug.toLowerCase().trim());
}

export function slugify(seed: string | null | undefined): string {
  return (seed || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
