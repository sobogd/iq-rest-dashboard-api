// One-shot backfill script: fills missing translations on every item and
// category for the companies whose primary user emails are passed as args.
// Locked translations are preserved (runMenuBackfill calls runItem with
// sourceNameChanged=false → only empty target fields get filled).
//
// Usage:  node dist/scripts/backfill-translations.js email1 email2 ...

import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { AutoTranslateService } from "../auto-translate/auto-translate.service";
import { PrismaService } from "../prisma/prisma.service";

async function main() {
  const emails = process.argv.slice(2).map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0) {
    console.error("Usage: node dist/scripts/backfill-translations.js email1 email2 ...");
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["log", "warn", "error"] });
  const prisma = app.get(PrismaService);
  const autoTranslate = app.get(AutoTranslateService);

  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { email: true, companies: { select: { companyId: true } } },
  });

  const resolved: { email: string; companyId: string }[] = [];
  for (const email of emails) {
    const u = users.find((x) => x.email === email);
    if (!u) {
      console.error(`[skip] no user for ${email}`);
      continue;
    }
    const companyId = u.companies[0]?.companyId;
    if (!companyId) {
      console.error(`[skip] ${email} has no company`);
      continue;
    }
    resolved.push({ email, companyId });
  }

  console.log(`Resolved ${resolved.length}/${emails.length} companies. Starting backfill...`);
  for (const { email, companyId } of resolved) {
    const t0 = Date.now();
    console.log(`→ ${email} (${companyId})`);
    try {
      const restaurants = await prisma.restaurant.findMany({
        where: { companyId },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      for (const r of restaurants) {
        await autoTranslate.runMenuBackfill(r.id);
      }
      console.log(`✓ ${email} done in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (err) {
      console.error(`✗ ${email} failed:`, err);
    }
  }

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
