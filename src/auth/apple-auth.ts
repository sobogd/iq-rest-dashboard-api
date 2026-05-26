// Sign in with Apple — web flow crypto helpers.
//
// Apple's OAuth differs from Google's in two ways we encapsulate here:
//   1. The `client_secret` is not a static string — it's a short-lived ES256
//      JWT signed with the .p8 private key, identifying the team + key + the
//      Services ID (web client_id). We mint a fresh one per token exchange so
//      there is nothing to rotate (Apple caps the lifetime at 6 months; we use
//      a few minutes).
//   2. The id_token is verified against Apple's JWKS, not a Google library.
//
// All Apple identifiers come from env (see AppleConfig). The private key is
// the full PKCS#8 PEM (`-----BEGIN PRIVATE KEY----- … `); when stored in a
// single-line .env we accept literal "\n" and restore the newlines.

import { SignJWT, importPKCS8, createRemoteJWKSet, jwtVerify } from "jose";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");

// Cached across requests — createRemoteJWKSet handles fetching + key rotation
// with its own in-memory cache, so we build it once at module load.
const appleJwks = createRemoteJWKSet(APPLE_JWKS_URL);

export interface AppleConfig {
  teamId: string;
  keyId: string;
  servicesId: string;
  /** Full PKCS#8 PEM. Literal "\n" sequences are restored to real newlines. */
  privateKey: string;
}

export interface AppleIdentity {
  /** Apple's stable per-user id (the `sub` claim). */
  sub: string;
  email?: string;
  emailVerified: boolean;
}

// ES256 JWT used as the OAuth client_secret. Short-lived: the only thing it
// has to outlive is the immediately-following /auth/token call.
async function buildClientSecret(cfg: AppleConfig): Promise<string> {
  const pem = cfg.privateKey.replace(/\\n/g, "\n");
  const key = await importPKCS8(pem, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: cfg.keyId })
    .setIssuer(cfg.teamId)
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .setAudience(APPLE_ISSUER)
    .setSubject(cfg.servicesId)
    .sign(key);
}

// Exchange the authorization code for tokens; returns the id_token JWT.
export async function exchangeAppleCode(
  cfg: AppleConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const clientSecret = await buildClientSecret(cfg);
  const body = new URLSearchParams({
    client_id: cfg.servicesId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const res = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Apple token exchange failed: ${res.status}`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("Apple did not return id_token");
  return json.id_token;
}

// Verify an Apple id_token against the JWKS and pull out the identity claims.
export async function verifyAppleIdToken(
  cfg: AppleConfig,
  idToken: string,
): Promise<AppleIdentity> {
  const { payload } = await jwtVerify(idToken, appleJwks, {
    issuer: APPLE_ISSUER,
    audience: cfg.servicesId,
  });
  const email = typeof payload.email === "string" ? payload.email : undefined;
  // Apple sends email_verified as either boolean or the string "true".
  const rawVerified = (payload as { email_verified?: boolean | string }).email_verified;
  const emailVerified = rawVerified === true || rawVerified === "true";
  return { sub: String(payload.sub), email, emailVerified };
}
