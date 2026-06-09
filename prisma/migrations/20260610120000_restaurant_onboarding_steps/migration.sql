-- First-login onboarding step flags (name step + fill step), persisted so the
-- modals never reappear once handled. New empty restaurants seeded on signup
-- start false; existing restaurants are backfilled to true so the onboarding
-- modals never show for accounts that already have data.
ALTER TABLE "restaurants" ADD COLUMN "onboardingNameDone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "onboardingFillDone" BOOLEAN NOT NULL DEFAULT false;

UPDATE "restaurants" SET "onboardingNameDone" = true, "onboardingFillDone" = true;
