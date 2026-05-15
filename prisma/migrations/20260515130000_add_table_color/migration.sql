-- Add a per-table color override. The dashboard floor map and table grid
-- show this color when set (in place of the image), letting owners pick a
-- distinguishing color per table without needing to upload a photo. The
-- public menu intentionally ignores this column — visitors still see the
-- image (or fallback) so they can recognise their table from the photo.

ALTER TABLE "tables" ADD COLUMN "color" TEXT;
