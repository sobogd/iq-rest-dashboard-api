// One-off: generate a top-down restaurant floor texture via Gemini and write it
// to the dashboard's public/floor.webp (used behind the table floor map).
// Run: npx ts-node -r dotenv/config scripts/gen-floor-texture.ts
import sharp from "sharp";
import { callGeminiImage } from "../src/common/gemini-image";

const OUT = "/Users/sobogd/work/iq-rest/iq-rest-dashboard-web/public/floor.webp";

const PROMPT = [
  "A seamless, perfectly top-down (orthographic, bird's-eye) photo of a warm wooden",
  "parquet restaurant floor. Even, flat, diffuse studio lighting with no shadows,",
  "no objects, no furniture, no people — just the floor surface filling the entire",
  "frame edge to edge. Natural oak herringbone planks in muted, mid-tone warm brown,",
  "subtle wood grain, gentle and uniform so it reads as a calm background. Slightly",
  "desaturated and a touch darker so light-coloured circular markers placed on top",
  "stand out clearly. Photorealistic, high detail, tileable, no vignette, no text.",
].join(" ");

async function main() {
  console.log("requesting texture from Gemini…");
  const b64 = await callGeminiImage({ prompt: PROMPT, aspectRatio: "1:1", timeoutMs: 90_000 });
  const buf = Buffer.from(b64, "base64");
  await sharp(buf).resize(1000, 1000, { fit: "cover" }).webp({ quality: 82 }).toFile(OUT);
  const kb = Math.round((await sharp(OUT).metadata()).size! / 1024) || 0;
  console.log("written", OUT, kb ? kb + "KB" : "");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
