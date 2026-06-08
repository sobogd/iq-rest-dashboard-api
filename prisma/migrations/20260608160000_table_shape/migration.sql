-- Floor-map marker shape per table: "circle" (default) or "rect".
ALTER TABLE "tables" ADD COLUMN "shape" TEXT NOT NULL DEFAULT 'circle';
