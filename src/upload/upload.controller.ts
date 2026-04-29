import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { s3Client, s3Bucket, s3Key, getPublicUrl } from "./s3";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

@Controller("upload")
@UseGuards(AuthGuard)
export class UploadController {
  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(@Req() req: Request, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file provided");
    if (![...IMAGE_TYPES, ...VIDEO_TYPES].includes(file.mimetype)) {
      throw new BadRequestException("Invalid file type");
    }
    const { companyId } = (req as AuthedRequest).authUser;

    const isImage = IMAGE_TYPES.includes(file.mimetype);
    const isGif = file.mimetype === "image/gif";

    let buffer: Buffer = file.buffer;
    let extension: string;
    let contentType: string;

    if (isImage && !isGif) {
      buffer = await sharp(buffer)
        .rotate()
        .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
        .sharpen({ sigma: 0.8, m1: 0.8, m2: 0.4 })
        .webp({ quality: 80 })
        .toBuffer();
      extension = "webp";
      contentType = "image/webp";
    } else if (VIDEO_TYPES.includes(file.mimetype)) {
      extension = file.mimetype === "video/quicktime" ? "mov" : file.mimetype.split("/")[1];
      contentType = file.mimetype;
    } else {
      extension = file.originalname.split(".").pop()?.toLowerCase() || file.mimetype.split("/")[1];
      contentType = file.mimetype;
    }

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 8);
    const key = s3Key("temp", companyId, `${timestamp}-${randomStr}.${extension}`);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ACL: "public-read",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    return { url: getPublicUrl(key) };
  }
}
