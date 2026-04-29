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
import { callGeminiImage, uploadGeneratedImage } from "../common/gemini-image";
import { consumeAiImageQuota, refundAiImageUsage } from "../common/ai-quota";
import { PrismaService } from "../prisma/prisma.service";

@Controller("items")
@UseGuards(AuthGuard)
export class ItemsController {
  constructor(private readonly svc: ItemsService, private readonly prisma: PrismaService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list((req as AuthedRequest).authUser.companyId);
  }

  @Post()
  create(@Req() req: Request, @Body() body: Parameters<ItemsService["create"]>[1]) {
    return this.svc.create((req as AuthedRequest).authUser.companyId, body);
  }

  @Put(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: Parameters<ItemsService["update"]>[2]) {
    return this.svc.update((req as AuthedRequest).authUser.companyId, id, body);
  }

  @Patch(":id")
  patch(@Req() req: Request, @Param("id") id: string, @Body() body: { isActive?: boolean }) {
    return this.svc.patch((req as AuthedRequest).authUser.companyId, id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove((req as AuthedRequest).authUser.companyId, id);
  }

  @Post("reorder")
  reorder(@Req() req: Request, @Body() body: { itemId: string; direction: "up" | "down" }) {
    return this.svc.reorder((req as AuthedRequest).authUser.companyId, body.itemId, body.direction);
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
    const { companyId } = (req as AuthedRequest).authUser;
    const { name, description, categoryName, accentColor, sourceImageUrl, prompt: userPrompt } = body;
    if (!userPrompt?.trim() && !name?.trim()) {
      throw new BadRequestException("Name or prompt is required");
    }
    const { restaurantId, isPaid } = await consumeAiImageQuota(this.prisma, companyId);
    const categoryLine = categoryName?.trim() ? `Category: ${categoryName.trim()}.` : "";
    const descLine = description?.trim() ? `${description.trim()}.` : "";

    let sourceB64: string | undefined;
    if (sourceImageUrl) {
      const imgRes = await fetch(sourceImageUrl, { cache: "no-store" });
      if (!imgRes.ok) throw new BadRequestException("Failed to fetch source image");
      sourceB64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
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
