/**
 * One-off: download each onboarding preset background, resize to 400px webp,
 * upload to S3 as `<key>-thumb.webp`. Run once whenever PRESETS list changes.
 *
 *   npx tsx scripts/generate-preset-thumbs.ts
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { config } from "dotenv";

config();

const PRESETS = [
  "files/backgrounds/dark-dining-v2.jpeg",
  "files/backgrounds/fresh-plate-v2.jpeg",
  "files/backgrounds/warm-bakery.jpeg",
  "files/backgrounds/rustic-wood.jpeg",
  "files/backgrounds/greenery-v2.jpeg",
  "files/backgrounds/ocean-night.jpeg",
  "files/backgrounds/midnight.jpeg",
  "files/backgrounds/wine-dine.jpeg",
];

const S3_HOST = process.env.S3_HOST!;
const S3_KEY = process.env.S3_KEY!;
const S3_TOKEN = process.env.S3_TOKEN!;
const S3_NAME = process.env.S3_NAME!;
const S3_REGION = process.env.S3_REGION!;

const s3 = new S3Client({
  endpoint: S3_HOST,
  region: S3_REGION,
  credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_TOKEN },
  forcePathStyle: true,
});

async function processOne(key: string) {
  const url = `${S3_HOST}/${S3_NAME}/${key}`;
  process.stdout.write(`  ${key} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const thumb = await sharp(buf)
    .resize(400, 400, { fit: "cover", position: "center" })
    .webp({ quality: 78 })
    .toBuffer();
  const thumbKey = key.replace(/\.[^./]+$/, "-thumb.webp");
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_NAME,
      Key: thumbKey,
      Body: thumb,
      ContentType: "image/webp",
      ACL: "public-read",
    }),
  );
  console.log(`→ ${thumbKey} (${(thumb.length / 1024).toFixed(1)}KB)`);
}

async function main() {
  console.log(`Generating ${PRESETS.length} thumbs...`);
  for (const k of PRESETS) {
    try {
      await processOne(k);
    } catch (e) {
      console.error("  FAIL:", e);
    }
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
