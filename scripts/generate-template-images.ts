/**
 * One-off: generate Gemini images for every cuisine template (dishes + restaurant background),
 * upload to S3 as optimized WebP, and write the resulting URLs to
 * src/onboarding/cuisine-template-images.json.
 *
 *   npx tsx scripts/generate-template-images.ts
 *
 * Re-runs are safe — already-generated keys are skipped unless --force is passed.
 */
// Side-effect import: must run before any module that reads process.env at top level
// (e.g. ../src/upload/s3.ts captures S3_REGION/S3_HOST/etc. at import time).
import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";

import { cuisineTemplates } from "../src/onboarding/cuisine-templates";
import { CUISINE_KEYS, type CuisineKey } from "../src/onboarding/cuisine";
import { callGeminiImage, uploadGeneratedImage } from "../src/common/gemini-image";

const FORCE = process.argv.includes("--force");
const CONCURRENCY = 3;
const OUT_PATH = path.join(__dirname, "..", "src", "onboarding", "cuisine-template-images.json");

/** Per-cuisine visual identity. Both the background hero and every dish image share these
 *  anchors so a customer browsing the menu sees a coherent look — same surface, same lighting,
 *  same palette, same mood. The only thing that varies between dishes is the food itself. */
type CuisineStyle = {
  /** Overall scene description, used in the background image prompt. */
  scene: string;
  /** Surface dishes are plated on (matches the background bar/table). */
  surface: string;
  /** Lighting style used in every shot of this cuisine. */
  lighting: string;
  /** Color palette anchors — repeated in every prompt for visual consistency. */
  palette: string;
  /** Plating/serving cue (plate type, garnish style) that fits the cuisine. */
  plating: string;
};

const CUISINE_STYLE: Record<CuisineKey, CuisineStyle> = {
  pizza: {
    scene: "cozy Italian pizzeria interior with a wood-fired brick oven glowing in the background, exposed brick wall, hanging baskets of garlic",
    surface: "rustic dark wooden table with subtle flour dusting",
    lighting: "warm amber tungsten light from above, soft shadows",
    palette: "warm terracotta, charred-crust brown, deep burgundy, golden amber, slate grey",
    plating: "served on a wooden pizza board or a simple white ceramic plate",
  },
  sushi: {
    scene: "minimalist Japanese sushi bar interior with a polished dark wood counter, single warm pendant light, raw stone wall, refined zen atmosphere",
    surface: "dark polished slate or matte black wood counter",
    lighting: "single soft warm overhead spotlight, deep shadows around the edges",
    palette: "matte black, charcoal grey, warm bamboo tan, accent of deep crimson",
    plating: "served on a long matte black slate board with a few wasabi and pickled ginger accents",
  },
  asian: {
    scene: "moody pan-Asian restaurant interior with red paper lanterns hanging overhead, dark lacquered wood, hints of bamboo and gold",
    surface: "black lacquered wood table with bamboo placemat",
    lighting: "warm red lantern glow from above, low-key dramatic side lighting",
    palette: "deep black, warm crimson, antique gold, bamboo green-tan, soft amber highlights",
    plating: "served in a black ceramic bowl or on a textured ceramic plate, chopsticks resting beside",
  },
  burger: {
    scene: "industrial American burger joint interior with exposed red brick wall, vintage edison bulbs strung overhead, weathered metal accents",
    surface: "rough dark wooden plank table, slight scuff marks",
    lighting: "warm amber edison-bulb tungsten light, soft golden glow",
    palette: "warm rust orange, charred dark brown, deep amber, weathered black, brass accents",
    plating: "served on a metal tray lined with kraft paper, with a small ramekin of sauce on the side",
  },
  coffee: {
    scene: "warm specialty coffee shop interior with a brass espresso machine on a light oak counter, soft natural daylight pouring through a tall window",
    surface: "light oak wooden table with a linen napkin in soft cream tone",
    lighting: "soft diffused natural daylight from a large side window, gentle shadows",
    palette: "warm cream, light oak tan, espresso brown, soft beige, brass highlights",
    plating: "served on a small white ceramic plate with a matching saucer, simple and minimal",
  },
  bar: {
    scene: "stylish craft cocktail bar interior with a backlit wall of liquor bottles, deep moody blue ambient light, polished black marble counter",
    surface: "polished black marble bar top with subtle white veining",
    lighting: "deep moody blue ambient with warm amber accent lighting from above, dramatic contrast",
    palette: "midnight blue, polished obsidian black, warm amber, glowing copper, hints of jade",
    plating: "served in elegant glassware or on a small dark slate board, garnished minimally",
  },
  bakery: {
    scene: "rustic European bakery interior with wooden shelves of fresh artisan bread loaves in the background, hanging copper utensils, warm morning sunlight",
    surface: "light flour-dusted oak wooden table with a soft beige linen cloth",
    lighting: "warm golden-hour morning sunlight from the side, soft natural shadows",
    palette: "warm cream, golden crust brown, soft beige, light oak, hint of butter yellow",
    plating: "served on a simple cream ceramic plate or a wooden board, sometimes on parchment",
  },
  restaurant: {
    scene: "elegant fine dining restaurant interior with dark walls, set table with crisp white tablecloth, dim candle lighting, cinematic mood",
    surface: "crisp white linen tablecloth on a dark wooden table",
    lighting: "single warm candlelight from above plus a soft fill light, dramatic deep shadows",
    palette: "deep charcoal, crisp white, warm brass, soft champagne gold, muted forest green accents",
    plating: "served on a fine white ceramic plate with a thin gold rim, elegant minimalist plating",
  },
};

type Cache = { dishes: Record<string, string>; backgrounds: Record<string, string> };

async function loadCache(): Promise<Cache> {
  try {
    const raw = await fs.readFile(OUT_PATH, "utf8");
    return JSON.parse(raw) as Cache;
  } catch {
    return { dishes: {}, backgrounds: {} };
  }
}

async function saveCache(cache: Cache): Promise<void> {
  await fs.writeFile(OUT_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

function dishPrompt(name: string, description: string | undefined, style: CuisineStyle): string {
  const desc = description ? ` (${description})` : "";
  return [
    `Professional food photography of "${name}"${desc}.`,
    `Plated ${style.plating}, set on a ${style.surface}.`,
    `Lighting: ${style.lighting}.`,
    `Color palette: ${style.palette}.`,
    `Background is the same restaurant interior — ${style.scene} — heavily blurred behind the food.`,
    "Shot from a 45-degree angle, sharp focus on the food, shallow depth of field, restaurant menu hero shot.",
    "Photorealistic, high detail, appetizing.",
    "Strictly no text, no labels, no logos, no people, no hands, no menus, no price tags.",
  ].join(" ");
}

function backgroundPrompt(style: CuisineStyle): string {
  return [
    `Atmospheric wide-angle hero shot of the interior: ${style.scene}.`,
    `Lighting: ${style.lighting}.`,
    `Color palette: ${style.palette}.`,
    "Soft cinematic depth, blurred background, the center area kept calm and uncluttered for overlay text.",
    "Photorealistic, professional interior photography, vertical 9:16 hero composition.",
    "Strictly no people, no text, no logos, no signage, no menus.",
  ].join(" ");
}

type Job =
  | { kind: "dish"; cacheKey: string; prompt: string; filenamePrefix: string }
  | { kind: "background"; cacheKey: string; prompt: string; filenamePrefix: string };

function buildJobs(cache: Cache): Job[] {
  const jobs: Job[] = [];

  for (const cuisine of CUISINE_KEYS) {
    const tpl = cuisineTemplates[cuisine];
    const style = CUISINE_STYLE[cuisine];

    if (FORCE || !cache.backgrounds[cuisine]) {
      jobs.push({
        kind: "background",
        cacheKey: cuisine,
        prompt: backgroundPrompt(style),
        filenamePrefix: `bg-${cuisine}`,
      });
    }

    tpl.items.forEach((item, idx) => {
      // Skip drink items — they're the kind of menu rows that look fine without a photo.
      if (isDrinkItem(cuisine, idx)) return;
      const key = `${cuisine}:${idx}`;
      if (!FORCE && cache.dishes[key]) return;
      const slug = item.name.en.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      jobs.push({
        kind: "dish",
        cacheKey: key,
        prompt: dishPrompt(item.name.en, item.description?.en, style),
        filenamePrefix: `dish-${cuisine}-${slug}`,
      });
    });
  }

  return jobs;
}

async function runJob(job: Job): Promise<{ url: string }> {
  const aspectRatio = job.kind === "background" ? "9:16" : "1:1";
  const b64 = await callGeminiImage({ prompt: job.prompt, aspectRatio, timeoutMs: 90_000 });
  const resize =
    job.kind === "background"
      ? { w: 1920, h: 1080, fit: "cover" as const }
      : { w: 1024, h: 1024, fit: "inside" as const };
  // q=80 + effort=6 + smartSubsample = perceptually lossless on food photography but
  // ~25-40% smaller than the previous q=85 default settings.
  const url = await uploadGeneratedImage(b64, {
    pathPrefix: job.kind === "background" ? "templates/backgrounds" : "templates/dishes",
    companyId: "",
    filenamePrefix: job.filenamePrefix,
    resize,
    quality: 80,
  });
  return { url };
}

/** Items inside a "Drinks" category (water, sodas, basic teas) get no image — they don't add
 *  much visual interest and inflate menu load. Identifies drink items by the category having
 *  the literal English name "Drinks". */
function isDrinkItem(cuisine: CuisineKey, itemIndex: number): boolean {
  const tpl = cuisineTemplates[cuisine];
  const item = tpl.items[itemIndex];
  if (!item) return false;
  const cat = tpl.categories[item.categoryIndex];
  return cat?.name.en === "Drinks";
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY missing in .env");
    process.exit(1);
  }
  if (!process.env.S3_HOST) {
    console.error("S3_* env vars missing in .env");
    process.exit(1);
  }

  const cache = await loadCache();
  const jobs = buildJobs(cache);

  console.log(`Jobs queued: ${jobs.length} (${jobs.filter((j) => j.kind === "background").length} backgrounds, ${jobs.filter((j) => j.kind === "dish").length} dishes)`);
  if (jobs.length === 0) {
    console.log("Nothing to do. Use --force to regenerate everything.");
    return;
  }

  let done = 0;
  let failed = 0;

  // Simple semaphore: chunk through the queue with CONCURRENCY workers.
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= jobs.length) return;
      const job = jobs[idx];
      const t0 = Date.now();
      try {
        const { url } = await runJob(job);
        if (job.kind === "dish") cache.dishes[job.cacheKey] = url;
        else cache.backgrounds[job.cacheKey] = url;
        done++;
        const ms = Date.now() - t0;
        console.log(`  [${done}/${jobs.length}] ${job.kind} ${job.cacheKey} ${ms}ms`);
        // Persist after each success so a crash mid-run doesn't lose progress.
        await saveCache(cache);
      } catch (err) {
        failed++;
        console.error(`  [FAIL] ${job.kind} ${job.cacheKey}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDone. Success: ${done - failed}, failed: ${failed}.`);
  console.log(`Output written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
