import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateOTP(): string {
  const buf = randomBytes(4);
  const num = (buf.readUInt32BE(0) % 900000) + 100000;
  return num.toString();
}

export function hashOTP(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export const MAX_OTP_ATTEMPTS = 5;
export const OTP_EXPIRY_MS = 5 * 60 * 1000;

export function authCookieOptions(domain?: string) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true",
    sameSite: "lax" as const,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days (express-cookie expects ms)
    path: "/",
    ...(domain ? { domain } : {}),
  };
}
