-- Floor-map marker rotation in degrees (0 = upright).
ALTER TABLE "tables" ADD COLUMN "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0;
