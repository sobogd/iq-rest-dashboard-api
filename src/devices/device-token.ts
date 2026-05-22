import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Compact HMAC-signed device token. Payload is the minimum needed to look up
// the Device row on each request and re-check tokenVersion + status. We avoid
// the JWT spec on purpose (smaller, no header negotiation, no algorithm
// confusion footgun) — this token only ever talks to our own API.
//
// Format: base64url(payloadJson) + "." + base64url(hmacSha256)

export interface DeviceTokenPayload {
  d: string; // deviceId
  v: number; // tokenVersion at issue time
  iat: number; // issued-at seconds since epoch
}

function getSecret(): Buffer {
  // Prefer a dedicated DEVICE_TOKEN_SECRET; otherwise fall back to
  // JWT_SECRET (already provisioned in every prod env). Final fallback is
  // a deterministic dev secret so a fresh localhost works without extra
  // config — checked-in by design.
  const raw = process.env.DEVICE_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!raw) {
    return Buffer.from("iqr-device-token-dev-secret-do-not-use-in-prod");
  }
  return Buffer.from(raw);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signDeviceToken(payload: DeviceTokenPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const mac = createHmac("sha256", getSecret()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

export function verifyDeviceToken(token: string): DeviceTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(mac);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(fromB64url(body).toString("utf8")) as DeviceTokenPayload;
    if (typeof parsed.d !== "string" || typeof parsed.v !== "number" || typeof parsed.iat !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function generatePairingCode(): string {
  // 6-digit numeric, leading zeros allowed. Range 000000–999999.
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0) % 1_000_000;
  return num.toString().padStart(6, "0");
}
