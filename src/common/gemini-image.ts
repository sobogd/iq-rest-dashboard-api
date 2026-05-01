import { PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { s3Client, s3Bucket, s3Key, getPublicUrl } from "../upload/s3";

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { inlineData?: { data: string } }[] } }[];
}

interface GeminiOpts {
  prompt: string;
  aspectRatio: "1:1" | "9:16";
  sourceImageWebpB64?: string;
  timeoutMs?: number;
}

export async function callGeminiImage(opts: GeminiOpts): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key not configured");

  const parts: GeminiPart[] = [{ text: opts.prompt }];
  if (opts.sourceImageWebpB64) {
    parts.push({ inline_data: { mime_type: "image/webp", data: opts.sourceImageWebpB64 } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 55_000);

  let res: Response;
  try {
    res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: opts.aspectRatio, imageSize: "1K" },
          },
        }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Gemini image error:", errText);
    throw new Error("Image generation failed");
  }

  const data = (await res.json()) as GeminiResponse;
  const imgPart = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  const b64 = imgPart?.inlineData?.data;
  if (!b64) throw new Error("No image returned");
  return b64;
}

interface UploadOpts {
  pathPrefix: string;
  companyId: string;
  filenamePrefix: string;
  resize: { w: number; h: number; fit: "inside" | "cover" };
  quality?: number;
}

export async function uploadGeneratedImage(b64: string, opts: UploadOpts): Promise<string> {
  const rawBuffer = Buffer.from(b64, "base64");
  let pipeline = sharp(rawBuffer).resize(opts.resize.w, opts.resize.h, {
    fit: opts.resize.fit,
    withoutEnlargement: opts.resize.fit === "inside",
  });
  if (opts.resize.fit === "inside") {
    pipeline = pipeline.sharpen({ sigma: 0.8, m1: 0.8, m2: 0.4 });
  }
  // effort=6 is the slowest WebP encoder mode but produces the smallest files for the same
  // quality target; smartSubsample preserves chroma fidelity on photos. Together they shave
  // ~25-40% off file size vs the default settings with no perceptible quality loss.
  const buffer = await pipeline
    .webp({ quality: opts.quality ?? 90, effort: 6, smartSubsample: true })
    .toBuffer();

  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const key = s3Key(opts.pathPrefix, opts.companyId, `${opts.filenamePrefix}-${timestamp}-${randomStr}.webp`);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: "image/webp",
      ACL: "public-read",
    }),
  );

  return getPublicUrl(key);
}
