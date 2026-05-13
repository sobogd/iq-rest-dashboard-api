// One-off backfill: assign each restaurant an IANA timezone based on its
// lat/lon (Restaurant.x, Restaurant.y stored as strings) via tz-lookup.
//
// Only touches rows where timezone is still the migration default ("UTC")
// — explicit user-set values are left alone.
//
// Usage (on the prod server with DATABASE_URL set):
//   npx tsx scripts/backfill-restaurant-timezone.ts          # dry-run
//   npx tsx scripts/backfill-restaurant-timezone.ts --apply  # mutate
//
// Falls back to "UTC" when no coordinates are present or tz-lookup throws.

import { PrismaClient } from "@prisma/client";
import tzlookup from "tz-lookup";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

function parseCoord(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const rows = await prisma.restaurant.findMany({
    where: { timezone: "UTC" },
    select: { id: true, title: true, x: true, y: true, address: true },
  });

  console.log(`Scanning ${rows.length} restaurants still on default UTC.\n`);
  let resolved = 0;
  let noCoords = 0;
  let lookupFailed = 0;

  for (const r of rows) {
    const lat = parseCoord(r.x);
    const lon = parseCoord(r.y);
    if (lat === null || lon === null) {
      noCoords++;
      console.log(`  [skip ] ${r.id} (${r.title}) — no coords`);
      continue;
    }
    let tz: string;
    try {
      tz = tzlookup(lat, lon);
    } catch (e) {
      lookupFailed++;
      console.log(`  [skip ] ${r.id} (${r.title}) — tz-lookup failed: ${(e as Error).message}`);
      continue;
    }
    console.log(`  [${APPLY ? " set " : " dry "}] ${r.id} (${r.title}) — ${lat},${lon} → ${tz}`);
    if (APPLY) {
      await prisma.restaurant.update({ where: { id: r.id }, data: { timezone: tz } });
    }
    resolved++;
  }

  console.log(`\nResult — resolved: ${resolved}, no coords: ${noCoords}, lookup failed: ${lookupFailed}`);
  if (!APPLY) console.log("Re-run with --apply to commit changes.");
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
