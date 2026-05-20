-- Item.diets — array of diet/lifestyle tags (vegan, vegetarian, gluten_free, ...).
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "diets" text[] NOT NULL DEFAULT '{}';

-- Category tree: groups vs leaves + self-referential parent.
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "isGroup" boolean NOT NULL DEFAULT false;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "parentId" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_parentId_fkey') THEN
    ALTER TABLE "categories"
      ADD CONSTRAINT "categories_parentId_fkey"
      FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "categories_companyId_parentId_sortOrder_idx"
  ON "categories" ("companyId", "parentId", "sortOrder");

-- Restaurant.menuLayout — "flat" (current) or "drill".
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "menuLayout" text NOT NULL DEFAULT 'flat';
