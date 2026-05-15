// One-off fix: order snapshots produced by the public menu were keyed under
// `en` regardless of the restaurant's defaultLanguage. As a result, on
// restaurants whose default isn't English, the new dashboard could not find a
// match for the default-language key and fell back to whichever locale the
// diner browsed in. Walk every order for the targeted company, rewrite each
// item so that:
//   1. dishNameSnapshot has a key equal to the restaurant's defaultLanguage
//      (copying the `en` value when no default-language key exists yet)
//   2. the flat `name` field reflects the same default-language string
//
// Usage (on the prod server with DATABASE_URL set):
//   npx tsx scripts/fix-order-snapshots-by-email.ts <user-email>          # dry-run
//   npx tsx scripts/fix-order-snapshots-by-email.ts <user-email> --apply  # mutate
//
// Targets every company the user is a member of. Skips orders whose items are
// already correctly keyed so the script is safe to re-run.

import { PrismaClient, Prisma } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const email = process.argv.find((a) => !a.startsWith("--") && a.includes("@"));

if (!email) {
  console.error("Usage: npx tsx fix-order-snapshots-by-email.ts <user-email> [--apply]");
  process.exit(1);
}

const prisma = new PrismaClient();

interface OrderItem {
  name?: string;
  dishId?: string;
  dishNameSnapshot?: Record<string, string>;
  [k: string]: unknown;
}

function fixItems(items: OrderItem[], defaultLang: string): { items: OrderItem[]; changed: boolean } {
  let changed = false;
  const next = items.map((it) => {
    if (!it || typeof it !== "object") return it;
    const snap = it.dishNameSnapshot;
    if (!snap || typeof snap !== "object") return it;

    const out: OrderItem = { ...it, dishNameSnapshot: { ...snap } };
    const outSnap = out.dishNameSnapshot as Record<string, string>;

    // Backfill the default-language slot from the legacy `en` slot when it's
    // missing. (If the menu had a real `en` translation, `en` will still hold
    // the actual English text — keep it.)
    if (!outSnap[defaultLang] && typeof outSnap.en === "string" && outSnap.en.length > 0) {
      outSnap[defaultLang] = outSnap.en;
      changed = true;
    }

    // Flat `name` field — used by the legacy soqrmenuweb dashboard. Force it
    // to the default-language snapshot so staff sees orders in their working
    // language instead of whichever locale the diner chose.
    const defaultName = outSnap[defaultLang];
    if (typeof defaultName === "string" && defaultName.length > 0 && it.name !== defaultName) {
      out.name = defaultName;
      changed = true;
    }

    return out;
  });

  return { items: next, changed };
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, companies: { select: { companyId: true } } },
  });
  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }
  const companyIds = user.companies.map((c) => c.companyId);
  if (companyIds.length === 0) {
    console.error(`User ${email} has no companies`);
    process.exit(1);
  }
  console.log(`User: ${user.email} (id=${user.id}) — ${companyIds.length} company(ies)`);

  for (const companyId of companyIds) {
    const restaurant = await prisma.restaurant.findFirst({
      where: { companyId },
      select: { id: true, title: true, defaultLanguage: true },
    });
    if (!restaurant) {
      console.log(`  company=${companyId}: no restaurant, skipping`);
      continue;
    }
    const defaultLang = restaurant.defaultLanguage || "en";
    console.log(`  company=${companyId} restaurant="${restaurant.title}" defaultLang=${defaultLang}`);

    const orders = await prisma.order.findMany({
      where: { companyId },
      select: { id: true, items: true, dailyNumber: true, orderDate: true },
    });
    console.log(`    ${orders.length} order(s) to inspect`);

    let touched = 0;
    let skipped = 0;
    for (const order of orders) {
      if (!Array.isArray(order.items)) {
        skipped++;
        continue;
      }
      const { items, changed } = fixItems(order.items as OrderItem[], defaultLang);
      if (!changed) {
        skipped++;
        continue;
      }
      touched++;
      console.log(`    order=${order.id} day=${order.orderDate.toISOString().slice(0, 10)} #${order.dailyNumber} — patched`);
      if (APPLY) {
        await prisma.order.update({
          where: { id: order.id },
          data: { items: items as unknown as Prisma.InputJsonValue },
        });
      }
    }
    console.log(`    touched=${touched} unchanged=${skipped}`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN. Re-run with --apply to persist changes.");
  } else {
    console.log("\nDone.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
