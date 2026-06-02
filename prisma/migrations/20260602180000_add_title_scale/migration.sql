-- Public-menu hero title/description font scale: "small" | "medium" | "large".
-- Backward-compatible add with a default, so existing restaurants keep the
-- current large size.
ALTER TABLE "restaurants" ADD COLUMN "titleScale" TEXT NOT NULL DEFAULT 'large';
