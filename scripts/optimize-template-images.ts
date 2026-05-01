/**
 * One-off: re-compress every template image (dishes + backgrounds) with stronger WebP settings,
 * upload as a new S3 key, and update src/onboarding/cuisine-template-images.json. Also drops
 * any image keyed to a "Drinks" category item so those rows render text-only.
 *
 *   npx tsx scripts/optimize-template-images.ts
 *
 * Does NOT call Gemini — purely re-encodes existing pixels, so re-running is free.
 * Old S3 objects are left in place (storage is cheap, can be cleaned up separately).
 */
import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, s3Bucket, s3Key, getPublicUrl } from "../src/upload/s3";
import { cuisineTemplates } from "../src/onboarding/cuisine-templates";
import { CUISINE_KEYS, type CuisineKey } from "../src/onboarding/cuisine";

const OUT_PATH = path.join(__dirname, "..", "src", "onboarding", "cuisine-template-images.json");
const CONCURRENCY = 4;
// Bump this whenever you re-optimize so old keys are not overwritten — keeps a paper trail.
const VERSION_TAG = "opt2";

type Cache = { dishes: Record<string, string>; backgrounds: Record<string, string> };

async function loadCache(): Promise<Cache> {
  const raw = await fs.readFile(OUT_PATH, "utf8");
  return JSON.parse(raw) as Cache;
}

async function saveCache(cache: Cache): Promise<void> {
  await fs.writeFile(OUT_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

function isDrinkItem(cuisine: CuisineKey, itemIndex: number): boolean {
  const tpl = cuisineTemplates[cuisine];
  const item = tpl.items[itemIndex];
  if (!item) return false;
  const cat = tpl.categories[item.categoryIndex];
  return cat?.name.en === "Drinks";
}

async function downloadBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function uploadOptimized(input: Buffer, kind: "dish" | "background", filenameBase: string): Promise<{ url: string; bytes: number }> {
  // Re-encode without resizing — image already at target dimensions from previous pass.
  const buffer = await sharp(input)
    .webp({ quality: 80, effort: 6, smartSubsample: true })
    .toBuffer();

  const key = s3Key(
    kind === "background" ? "templates/backgrounds" : "templates/dishes",
    `${filenameBase}-${VERSION_TAG}.webp`,
  );

  await s3Client.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: "image/webp",
      ACL: "public-read",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  return { url: getPublicUrl(key), bytes: buffer.length };
}

async function processOne(
  type: "dish" | "background",
  url: string,
): Promise<{ url: string; before: number; after: number }> {
  const original = await downloadBytes(url);
  // Reuse the original filename (sans the timestamp/random suffix) as the new base.
  const oldName = url.split("/").pop() || "image.webp";
  const base = oldName.replace(/\.webp$/i, "").replace(/-\d{13}-[a-z0-9]+$/i, "");
  const result = await uploadOptimized(original, type, base);
  return { url: result.url, before: original.length, after: result.bytes };
}

async function main(): Promise<void> {
  if (!process.env.S3_HOST) {
    console.error("S3_* env vars missing in .env");
    process.exit(1);
  }

  const cache = await loadCache();
  const newCache: Cache = { dishes: {}, backgrounds: {} };

  // Backgrounds — always kept.
  const bgJobs: Array<{ key: string; url: string }> = Object.entries(cache.backgrounds).map(
    ([key, url]) => ({ key, url }),
  );

  // Dishes — drop drink items.
  const dishJobs: Array<{ key: string; url: string }> = [];
  let droppedDrinks = 0;
  for (const [key, url] of Object.entries(cache.dishes)) {
    const [cuisine, idxStr] = key.split(":");
    const idx = Number(idxStr);
    if (CUISINE_KEYS.includes(cuisine as CuisineKey) && isDrinkItem(cuisine as CuisineKey, idx)) {
      droppedDrinks++;
      continue;
    }
    dishJobs.push({ key, url });
  }

  console.log(
    `Re-optimizing ${bgJobs.length} backgrounds + ${dishJobs.length} dishes ` +
      `(dropped ${droppedDrinks} drink items).`,
  );

  let totalBefore = 0;
  let totalAfter = 0;
  let done = 0;
  let failed = 0;
  const all: Array<{ kind: "dish" | "background"; key: string; url: string }> = [
    ...bgJobs.map((j) => ({ kind: "background" as const, ...j })),
    ...dishJobs.map((j) => ({ kind: "dish" as const, ...j })),
  ];

  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= all.length) return;
      const job = all[idx];
      const t0 = Date.now();
      try {
        const r = await processOne(job.kind, job.url);
        if (job.kind === "background") newCache.backgrounds[job.key] = r.url;
        else newCache.dishes[job.key] = r.url;
        totalBefore += r.before;
        totalAfter += r.after;
        done++;
        const pct = ((1 - r.after / r.before) * 100).toFixed(1);
        console.log(
          `  [${done}/${all.length}] ${job.kind} ${job.key} ${(r.before / 1024).toFixed(0)}→${(r.after / 1024).toFixed(0)} KB (-${pct}%) ${Date.now() - t0}ms`,
        );
        await saveCache(newCache);
      } catch (err) {
        failed++;
        console.error(`  [FAIL] ${job.kind} ${job.key}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const totalSavedKb = (totalBefore - totalAfter) / 1024;
  const pct = ((1 - totalAfter / totalBefore) * 100).toFixed(1);
  console.log(`\nDone. Success: ${done - failed}, failed: ${failed}.`);
  console.log(`Total: ${(totalBefore / 1024).toFixed(0)} KB → ${(totalAfter / 1024).toFixed(0)} KB (saved ${totalSavedKb.toFixed(0)} KB, -${pct}%).`);
  console.log(`Output written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
