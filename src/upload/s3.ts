import { S3Client } from "@aws-sdk/client-s3";

const host = process.env.S3_HOST!;
const region = process.env.S3_REGION!;
const accessKeyId = process.env.S3_KEY!;
const secretAccessKey = process.env.S3_TOKEN!;
const bucket = process.env.S3_NAME!;

export const s3Client = new S3Client({
  endpoint: host,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
});

export const s3Bucket = bucket;

export function s3Key(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

export function getPublicUrl(key: string): string {
  return `${host}/${bucket}/${key}`;
}
