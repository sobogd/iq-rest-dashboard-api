import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { s3Client, s3Bucket, s3Key } from "../upload/s3";

const MAX_SIZE = 100 * 1024 * 1024;
const MAX_FILES = 5;

interface ScannedItem {
  name: string;
  price: number;
  description?: string;
}

interface ScannedCategory {
  name: string;
  items: ScannedItem[];
}

interface ScanResult {
  categories?: ScannedCategory[];
  error?: string;
}

async function compressForVision(base64Data: string): Promise<{ mimeType: string; base64: string }> {
  const inputBuffer = Buffer.from(base64Data, "base64");
  const compressed = await sharp(inputBuffer)
    .resize(4096, 4096, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 95 })
    .toBuffer();
  return { mimeType: "image/jpeg", base64: compressed.toString("base64") };
}

@Controller("scan-menu")
@UseGuards(AuthGuard)
export class ScanMenuController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("parse")
  async parse(@Req() req: Request, @Body() body: { images?: string[]; image?: string }) {
    const { companyId } = (req as AuthedRequest).authUser;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new HttpException("Gemini API key not configured", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const rawFiles: string[] = Array.isArray(body.images)
      ? body.images
      : body.image
        ? [body.image]
        : [];

    if (rawFiles.length === 0) throw new BadRequestException("At least one file is required");
    if (rawFiles.length > MAX_FILES) throw new BadRequestException("too_many_images");

    // Save originals to S3 (fire-and-forget)
    const timestamp = Date.now();
    Promise.all(
      rawFiles.map(async (file, i) => {
        try {
          const mimeMatch = file.match(/^data:([^;]+);base64,/);
          if (!mimeMatch) return;
          const mime = mimeMatch[1];
          const base64Data = file.split(",")[1];
          const buffer = Buffer.from(base64Data, "base64");
          const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1] || "bin";
          const key = s3Key("scan_onboarding", companyId, `${timestamp}-${i}.${ext}`);
          await s3Client.send(
            new PutObjectCommand({
              Bucket: s3Bucket,
              Key: key,
              Body: buffer,
              ContentType: mime,
            }),
          );
        } catch (err) {
          console.error("Failed to save scan file to S3:", err);
        }
      }),
    ).catch(() => undefined);

    const contentParts: { inline_data: { mime_type: string; data: string } }[] = [];

    for (const file of rawFiles) {
      if (typeof file !== "string") throw new BadRequestException("Invalid file data");

      const isPdf = file.startsWith("data:application/pdf;base64,");
      const base64Data = file.split(",")[1] ?? "";
      const sizeInBytes = (base64Data.length * 3) / 4;
      if (sizeInBytes > MAX_SIZE) throw new BadRequestException("too_large");

      if (isPdf) {
        contentParts.push({ inline_data: { mime_type: "application/pdf", data: base64Data } });
      } else {
        const mimeMatch = file.match(/^data:image\/[a-z+]+;base64,/);
        if (!mimeMatch) throw new BadRequestException("Invalid file format");
        const compressed = await compressForVision(base64Data);
        contentParts.push({ inline_data: { mime_type: compressed.mimeType, data: compressed.base64 } });
      }
    }

    const multiImageNote = contentParts.length > 1
      ? `\nYou are receiving ${contentParts.length} files — these are different pages of the SAME menu. Combine all items from all pages into a single unified result. Do not duplicate categories — merge items into the same category if they belong together.`
      : "";

    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: `You are a menu scanner. Analyze the image(s) of a restaurant menu and extract all items with their prices.${multiImageNote}

Return valid JSON in this exact format:
{
  "categories": [
    {
      "name": "Category Name",
      "items": [
        { "name": "Item Name", "price": 14.50, "description": "Optional description" }
      ]
    }
  ]
}

Rules:
- Group items into logical categories (e.g. "Starters", "Main Course", "Desserts", "Drinks")
- Extract prices as numbers (no currency symbols). If no price is visible, use 0
- If the image is NOT a restaurant menu, return: { "error": "not_a_menu" }`,
            }],
          },
          contents: [{
            role: "user",
            parts: [{ text: "Scan this menu" }, ...contentParts],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 50000,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!res.ok) {
      console.error("Gemini API error:", await res.text());
      throw new HttpException("Failed to analyze menu", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!content) throw new HttpException("No response from AI", HttpStatus.INTERNAL_SERVER_ERROR);

    let scanResult: ScanResult;
    try {
      scanResult = JSON.parse(content) as ScanResult;
    } catch {
      console.error("Failed to parse AI response:", content);
      throw new HttpException("Failed to parse menu data", HttpStatus.INTERNAL_SERVER_ERROR);
    }

    if (scanResult.error === "not_a_menu") {
      throw new HttpException("not_a_menu", HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (!scanResult.categories || scanResult.categories.length === 0) {
      throw new HttpException("not_a_menu", HttpStatus.UNPROCESSABLE_ENTITY);
    }

    return { categories: scanResult.categories };
  }

  @Post("save")
  async save(
    @Req() req: Request,
    @Body() body: { categories?: ScannedCategory[]; replaceExisting?: boolean },
  ) {
    const { companyId } = (req as AuthedRequest).authUser;

    const incoming = (body.categories ?? []).filter(
      (c) => c.name && Array.isArray(c.items) && c.items.length > 0,
    );
    if (incoming.length === 0) throw new BadRequestException("No items selected");

    // Always remove example items
    await this.prisma.item.deleteMany({ where: { companyId, isExample: true } });

    // Optionally remove all real items
    if (body.replaceExisting) {
      await this.prisma.item.deleteMany({ where: { companyId } });
    }

    // Drop categories that became empty
    const empty = await this.prisma.category.findMany({
      where: { companyId, items: { none: {} } },
      select: { id: true },
    });
    if (empty.length > 0) {
      await this.prisma.category.deleteMany({
        where: { id: { in: empty.map((c) => c.id) } },
      });
    }

    const existingCategoriesCount = await this.prisma.category.count({ where: { companyId } });

    let categoriesCount = 0;
    let itemsCount = 0;

    for (let i = 0; i < incoming.length; i++) {
      const cat = incoming[i];
      const category = await this.prisma.category.create({
        data: {
          name: cat.name,
          sortOrder: existingCategoriesCount + i,
          isActive: true,
          companyId,
        },
      });
      categoriesCount++;

      const itemsData = cat.items
        .filter((item) => item.name)
        .map((item, j) => ({
          name: item.name,
          description: item.description ?? null,
          price: Math.max(0, Number(item.price) || 0),
          sortOrder: j,
          isActive: true,
          categoryId: category.id,
          companyId,
        }));

      if (itemsData.length > 0) {
        await this.prisma.item.createMany({ data: itemsData });
        itemsCount += itemsData.length;
      }
    }

    await this.prisma.restaurant.updateMany({
      where: { companyId },
      data: { checklistMenuEdited: true, fromScanner: true },
    });

    return { ok: true, categoriesCount, itemsCount };
  }
}
