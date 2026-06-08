-- Floor-map marker size as percent of the map (null = capacity-derived default).
ALTER TABLE "tables" ADD COLUMN "width" DOUBLE PRECISION;
ALTER TABLE "tables" ADD COLUMN "height" DOUBLE PRECISION;
