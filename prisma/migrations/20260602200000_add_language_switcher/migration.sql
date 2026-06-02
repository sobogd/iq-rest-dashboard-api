-- Public-menu language switcher placement: "inline" (nav-list row) | "top"
-- (globe icon over the hero). Backward-compatible add with a default, so
-- existing restaurants keep the current inline placement. New restaurants are
-- seeded with "top" in the onboarding service.
ALTER TABLE "restaurants" ADD COLUMN "languageSwitcher" TEXT NOT NULL DEFAULT 'inline';
