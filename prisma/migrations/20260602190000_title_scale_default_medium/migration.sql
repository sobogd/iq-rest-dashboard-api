-- New restaurants default to the medium hero title size (was large). Existing
-- rows keep their stored value; only the column default changes.
ALTER TABLE "restaurants" ALTER COLUMN "titleScale" SET DEFAULT 'medium';
