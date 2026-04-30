-- First-touch attribution columns. Set on session create, never updated.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "country" TEXT,
  ADD COLUMN IF NOT EXISTS "city" TEXT,
  ADD COLUMN IF NOT EXISTS "gclid" TEXT;
