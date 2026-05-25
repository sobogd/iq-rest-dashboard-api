import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { ItemsService } from "./items.service";
import {
  CreateItemDto,
  PatchItemDto,
  ReorderBulkDto,
  ReorderItemDto,
  UpdateItemDto,
} from "./dto";
import { callGeminiImage, uploadGeneratedImage } from "../common/gemini-image";
import { consumeAiImageQuota, refundAiImageUsage } from "../common/ai-quota";
import { PrismaService } from "../prisma/prisma.service";

function ctx(req: Request) {
  const { companyId, restaurantId } = (req as AuthedRequest).authUser;
  return { companyId, restaurantId };
}

@Controller("items")
@UseGuards(AuthGuard)
export class ItemsController {
  constructor(private readonly svc: ItemsService, private readonly prisma: PrismaService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(ctx(req));
  }

  @Post()
  create(@Req() req: Request, @Body() body: CreateItemDto) {
    return this.svc.create(ctx(req), body);
  }

  @Put(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: UpdateItemDto) {
    return this.svc.update(ctx(req), id, body);
  }

  @Patch(":id")
  patch(@Req() req: Request, @Param("id") id: string, @Body() body: PatchItemDto) {
    return this.svc.patch(ctx(req), id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove(ctx(req), id);
  }

  @Post("reorder")
  reorder(@Req() req: Request, @Body() body: ReorderItemDto) {
    return this.svc.reorder(ctx(req), body.itemId, body.direction);
  }

  @Post("reorder-bulk")
  reorderBulk(@Req() req: Request, @Body() body: ReorderBulkDto) {
    return this.svc.reorderBulk(ctx(req), body.items);
  }

  @Post("generate-image")
  async generateImage(
    @Req() req: Request,
    @Body() body: {
      name?: string;
      description?: string;
      categoryName?: string;
      accentColor?: string;
      sourceImageUrl?: string;
      prompt?: string;
    },
  ) {
    const { companyId, restaurantId } = (req as AuthedRequest).authUser;
    const { name, description, categoryName, accentColor, sourceImageUrl, prompt: userPrompt } = body;
    if (!userPrompt?.trim() && !name?.trim()) {
      throw new BadRequestException("Name or prompt is required");
    }
    const { isPaid } = await consumeAiImageQuota(this.prisma, restaurantId);
    const categoryLine = categoryName?.trim() ? `Category: ${categoryName.trim()}.` : "";
    const descLine = description?.trim() ? `${description.trim()}.` : "";

    let sourceB64: string | undefined;
    if (sourceImageUrl) {
      // SSRF guard: only fetch from our own S3 bucket (the URL always comes
      // from a previously-uploaded item image). Anything else — internal
      // hosts, cloud metadata endpoints — is rejected outright.
      const allowedBase = `${process.env.S3_HOST}/${process.env.S3_NAME}/`;
      if (!sourceImageUrl.startsWith(allowedBase)) {
        throw new BadRequestException("Invalid source image URL");
      }
      const imgRes = await fetch(sourceImageUrl, { cache: "no-store" });
      if (!imgRes.ok) throw new BadRequestException("Failed to fetch source image");
      const declared = Number(imgRes.headers.get("content-length") || 0);
      const MAX_BYTES = 15_000_000;
      if (declared > MAX_BYTES) throw new BadRequestException("Source image too large");
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new BadRequestException("Source image too large");
      sourceB64 = buf.toString("base64");
    }

    let prompt: string;
    if (sourceB64) {
      const bgColorLine = accentColor
        ? `Use accent color ${accentColor} subtly in the surface or surroundings (napkin, surface tint, decorative element).`
        : "";
      prompt = [
        "CRITICAL: Do NOT alter, redraw, or modify the food, dish, plate, or bowl in ANY way. Preserve every pixel of the food exactly as it appears.",
        "ONLY replace the background behind and around the dish:",
        "- Place on a clean, elegant minimalist surface (marble, light wood, or ceramic).",
        "- Apply soft diffused studio lighting with gentle shadows under the plate.",
        bgColorLine,
        "- Leave generous padding around the dish — nothing should touch or be cropped by the edges.",
        "- No text, no watermarks, no hands, no extra objects.",
        "- High-end restaurant menu photo style.",
      ].filter(Boolean).join("\n");
    } else {
      const colorLine = accentColor ? `Accent color ${accentColor} subtly in plate rim or garnish.` : "";
      prompt = userPrompt?.trim()
        ? [
            userPrompt.trim(),
            "Top-down 45-degree angle on a clean minimalist surface.",
            colorLine,
            "Leave generous padding around the dish and plate — neither the food nor the plate should touch or be cropped by the edges of the image.",
            "Soft diffused studio lighting. No text, no watermarks, no hands.",
            "High-end restaurant menu style, appetizing presentation.",
          ].filter(Boolean).join("\n")
        : [
            `Professional food photograph of "${name!.trim()}".`,
            categoryLine,
            descLine,
            "Top-down 45-degree angle on a clean minimalist surface.",
            colorLine,
            "Leave generous padding around the dish and plate — neither the food nor the plate should touch or be cropped by the edges of the image.",
            "Soft diffused studio lighting. No text, no watermarks, no hands.",
            "High-end restaurant menu style, appetizing presentation.",
          ].filter(Boolean).join("\n");
    }

    try {
      const b64 = await callGeminiImage({ prompt, aspectRatio: "1:1", sourceImageWebpB64: sourceB64 });
      const url = await uploadGeneratedImage(b64, {
        pathPrefix: "temp",
        companyId,
        filenamePrefix: "ai",
        resize: { w: 1500, h: 1500, fit: "inside" },
        quality: 90,
      });
      return { url };
    } catch (err) {
      if (!isPaid) await refundAiImageUsage(this.prisma, restaurantId);
      throw err;
    }
  }
}
