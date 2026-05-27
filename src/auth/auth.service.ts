import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { I18nService } from "../i18n/i18n.service";
import { OnboardingSeedService } from "../onboarding/onboarding-seed.service";
import { isCuisineKey, type CuisineKey } from "../onboarding/cuisine";
import {
  generateOTP,
  generateSessionToken,
  hashOTP,
  hashSessionToken,
  MAX_OTP_ATTEMPTS,
  OTP_EXPIRY_MS,
  safeCompare,
} from "../common/session-utils";
import { validateEmail } from "../common/validate-email";

export type SignupContext = { cuisine: string; restaurantName: string };

const SEND_LIMIT_WINDOW = 15 * 60 * 1000;
const SEND_LIMIT_MAX = 5;
const VERIFY_LIMIT_WINDOW = 15 * 60 * 1000;
const VERIFY_LIMIT_MAX = 10;

// Specific accounts that stay on the legacy monolith dashboard at iq-rest.com/<locale>/dashboard.
// Stored as salted SHA-256 hashes so the addresses are not visible in the repo. Bump LEGACY_SALT
// to invalidate every entry at once (e.g. after rotating who's on legacy).
const LEGACY_SALT = "iqr-legacy-v1";
const LEGACY_EMAIL_HASHES = new Set<string>([
  "4308dbfd8111b3a6cfc8655dc23c843d2ffbd3541831315f2ffe240421ab7169",
  "7f9765f0ff8e32b88b54a14b4ba773a5b782e653b139dd47d3c78e9188aad5eb",
  // "8f9e4fafa7606a6757c532ad0b0d66e882dd6d53deda494b3af481244c65aa5d", // support@iq-rest.com — TEMP off, admin testing new dashboard
  "bfd849ef637d5f481afecc13b46f5bcab6b19f271f733a8d4a377ea1b6a28338", // sobogd@gmail.com — test routing to legacy dashboard
]);

function hashLegacyEmail(email: string): string {
  return createHash("sha256")
    .update(LEGACY_SALT + ":" + email.trim().toLowerCase())
    .digest("hex");
}

function isLegacyEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return LEGACY_EMAIL_HASHES.has(hashLegacyEmail(email));
}

// Demo account: a fixed credential so we can hand out read-the-product access
// without provisioning a real mailbox. The fixed code skips OTP verification
// and no email is sent for it. Intentional backdoor scoped to this one email.
const DEMO_EMAIL = "demo@iq-rest.com";
const DEMO_CODE = "000000";

@Injectable()
export class AuthService implements OnModuleDestroy {
  private sendAttempts = new Map<string, { count: number; resetAt: number }>();
  private verifyAttempts = new Map<string, { count: number; resetAt: number }>();
  // Drop expired rate-limit entries periodically so the Maps don't grow forever
  // under abuse (each unique email leaves a record otherwise).
  private readonly rateLimitSweep = setInterval(() => this.sweepRateLimits(), 10 * 60 * 1000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly i18n: I18nService,
    private readonly seed: OnboardingSeedService,
  ) {
    // Don't keep the Node process alive for the cleanup timer alone.
    this.rateLimitSweep.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.rateLimitSweep);
  }

  private sweepRateLimits(): void {
    const now = Date.now();
    for (const map of [this.sendAttempts, this.verifyAttempts]) {
      for (const [key, entry] of map) {
        if (now > entry.resetAt) map.delete(key);
      }
    }
  }

  private rateLimit(map: Map<string, { count: number; resetAt: number }>, key: string, max: number, window: number): boolean {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry || now > entry.resetAt) {
      map.set(key, { count: 1, resetAt: now + window });
      return false;
    }
    entry.count++;
    return entry.count > max;
  }

  async sendOtp(
    emailRaw: string,
    locale = "en",
    signupContext?: SignupContext,
    currency?: string,
  ): Promise<{ isNewUser: boolean }> {
    const email = validateEmail(emailRaw);
    if (!email) throw new BadRequestException("Invalid email");

    if (this.rateLimit(this.sendAttempts, email, SEND_LIMIT_MAX, SEND_LIMIT_WINDOW)) {
      throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
    }

    const code = generateOTP();
    const otpHash = hashOTP(code);
    const otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    const normalizedLocale = this.i18n.urlLocale(locale);
    let pending = this.normalizeSignupContext(signupContext, currency);

    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    let isNewUser = false;

    // Brand-new email and no create-flow context → seed a generic template anyway so the user
    // doesn't land on a blank dashboard. Existing users are left alone (their pending fields
    // are not overwritten with defaults).
    if (!existing && Object.keys(pending).length === 0) {
      pending = this.defaultSignupContext(email, currency);
    }

    if (existing) {
      await this.prisma.user.update({
        where: { email },
        data: {
          otp: otpHash,
          otpExpiresAt,
          otpAttempts: 0,
          preferredLocale: normalizedLocale,
          ...pending,
        },
      });
    } else {
      isNewUser = true;
      try {
        await this.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email,
              otp: otpHash,
              otpExpiresAt,
              otpAttempts: 0,
              preferredLocale: normalizedLocale,
              ...pending,
            },
          });
          const company = await tx.company.create({
            data: {
              name: this.i18n.bundle(locale).companyDefaultName,
              onboardingStep: 0,
              trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            },
          });
          await tx.userCompany.create({
            data: { userId: user.id, companyId: company.id, role: "owner" },
          });
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          // Race: another request created the user. Update OTP on existing.
          // No company is leaked because the transaction rolled the create back.
          await this.prisma.user.update({
            where: { email },
            data: {
              otp: otpHash,
              otpExpiresAt,
              otpAttempts: 0,
              preferredLocale: normalizedLocale,
              ...pending,
            },
          });
          isNewUser = false;
        } else {
          throw e;
        }
      }
    }

    // Demo account accepts the fixed DEMO_CODE in verifyOtp — no real email.
    if (email !== DEMO_EMAIL) {
      await this.mail.sendOtp({ email, code, locale });
    }
    return { isNewUser };
  }

  /** Pick out a pending-signup-context field set, or empty object if no valid context.
   *  Cuisine is validated via the literal whitelist; restaurantName is trimmed and capped. */
  private normalizeSignupContext(
    ctx: SignupContext | undefined,
    currency: string | undefined,
  ): { pendingCuisine: CuisineKey; pendingRestaurantName: string; pendingCurrency: string } | Record<string, never> {
    if (!ctx || !isCuisineKey(ctx.cuisine)) return {};
    const name = ctx.restaurantName?.trim().slice(0, 120);
    if (!name) return {};
    return {
      pendingCuisine: ctx.cuisine,
      pendingRestaurantName: name,
      pendingCurrency: currency || "EUR",
    };
  }

  /** Fallback context for a brand-new user who didn't go through the create-flow (i.e. came in
   *  via plain /login). Picks the generic "restaurant" cuisine and derives a name from the
   *  email local-part so they still land in a populated dashboard. */
  private defaultSignupContext(
    email: string,
    currency: string | undefined,
  ): { pendingCuisine: CuisineKey; pendingRestaurantName: string; pendingCurrency: string } {
    const local = email.split("@")[0] || "my";
    const cleaned = local.replace(/[._-]+/g, " ").trim().slice(0, 40);
    const name = cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "My";
    return {
      pendingCuisine: "restaurant",
      pendingRestaurantName: `${name}'s Restaurant`,
      pendingCurrency: currency || "EUR",
    };
  }

  /** After a successful auth (OTP or Google), if the user has a stored signup context AND no
   *  restaurant yet, seed a template restaurant. Pending fields are cleared **only on success**
   *  so a transient seed failure can be retried by simply logging in again.
   *  Returns true when seeding actually happened in this call (so callers can skip a follow-up
   *  query for the now-flipped onboardingStep). */
  private async applyPendingAndMaybeSeed(userId: string, fallbackLocale: string | null | undefined): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        pendingCuisine: true,
        pendingRestaurantName: true,
        pendingCurrency: true,
        preferredLocale: true,
        companies: {
          take: 1,
          select: {
            company: {
              select: { id: true, restaurants: { take: 1, select: { id: true } } },
            },
          },
        },
      },
    });
    if (!user?.pendingCuisine) return false;

    const company = user.companies[0]?.company;
    const hasRestaurant = (company?.restaurants?.length ?? 0) > 0;

    // No company or restaurant already exists → context is moot; clear pending and exit.
    if (!company || hasRestaurant || !isCuisineKey(user.pendingCuisine)) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { pendingCuisine: null, pendingRestaurantName: null, pendingCurrency: null },
      });
      return false;
    }

    let seeded = false;
    try {
      await this.seed.seedTemplate({
        companyId: company.id,
        cuisine: user.pendingCuisine,
        restaurantName: user.pendingRestaurantName || "My Restaurant",
        currency: user.pendingCurrency || "EUR",
        locale: user.preferredLocale || fallbackLocale,
      });
      seeded = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[auth] template seed failed — pending kept for retry on next login", err);
    }

    if (seeded) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { pendingCuisine: null, pendingRestaurantName: null, pendingCurrency: null },
      });
    }
    return seeded;
  }

  async verifyOtp(emailRaw: string, code: string): Promise<{ token: string; userId: string; onboardingStep: number; isNewUser: boolean; legacyDashboard: boolean }> {
    const email = validateEmail(emailRaw);
    if (!email || !code) throw new BadRequestException("Email and code required");

    if (this.rateLimit(this.verifyAttempts, email, VERIFY_LIMIT_MAX, VERIFY_LIMIT_WINDOW)) {
      throw new HttpException("Too many attempts", HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { companies: { take: 1, include: { company: true } } },
    });

    // Demo account: skip all OTP validation when the fixed code is given. The
    // row itself must exist (sendOtp creates it on first login), but its otp /
    // expiry / attempt counters are irrelevant for the bypass.
    const isDemoBypass = email === DEMO_EMAIL && code === DEMO_CODE;

    if (!user) {
      throw new BadRequestException("INVALID_CODE");
    }

    if (!isDemoBypass) {
      if (!user.otp || !user.otpExpiresAt) {
        throw new BadRequestException("INVALID_CODE");
      }

      if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
        await this.prisma.user.update({
          where: { email },
          data: { otp: null, otpExpiresAt: null, otpAttempts: 0 },
        });
        throw new HttpException("TOO_MANY_ATTEMPTS", HttpStatus.TOO_MANY_REQUESTS);
      }

      if (user.otpExpiresAt < new Date()) {
        await this.prisma.user.update({
          where: { email },
          data: { otp: null, otpExpiresAt: null, otpAttempts: 0 },
        });
        throw new BadRequestException("CODE_EXPIRED");
      }

      if (!safeCompare(user.otp, hashOTP(code))) {
        await this.prisma.user.update({
          where: { email },
          data: { otpAttempts: { increment: 1 } },
        });
        throw new BadRequestException("INVALID_CODE");
      }
    }

    // Success — issue session token.
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);

    await this.prisma.user.update({
      where: { email },
      data: {
        otp: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        // Dual-write: legacy single-token column kept until phase B (drop on
        // 2026-05-13). Multi-device login now lives in the `sessions` table.
        sessionToken: tokenHash,
      },
    });
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    // If signup-flow context was attached on send-otp, seed the template restaurant now.
    const seeded = await this.applyPendingAndMaybeSeed(user.id, null);

    const companyEdge = user.companies[0];
    // Seeder flips company.onboardingStep to 3 on success — derive locally to avoid a re-query.
    const finalStep = seeded ? 3 : companyEdge?.company?.onboardingStep ?? 0;
    const legacyDashboard = isLegacyEmail(email);
    return {
      token,
      userId: user.id,
      onboardingStep: finalStep,
      isNewUser: !companyEdge?.company || finalStep < 3,
      legacyDashboard,
    };
  }

  /** Resolve user from session cookie. Throws Unauthorized when missing/invalid.
   *
   *  When admin_original_* cookies are present we are inside an impersonation
   *  session: validate the **admin's** session token (kept untouched in
   *  iqr_session) and skip target sessionToken validation entirely so the
   *  target user keeps their existing login. */
  async resolveSession(
    cookieValue: string | undefined,
    email: string | undefined,
    impersonation?: { adminOrigSession?: string; adminOrigEmail?: string },
  ): Promise<{ userId: string; companyId: string; email: string; onboardingStep: number; legacyDashboard: boolean }> {
    if (!cookieValue || !email) throw new UnauthorizedException();
    const adminEmail = impersonation?.adminOrigEmail;
    const adminSession = impersonation?.adminOrigSession;
    const isImpersonating = Boolean(adminEmail && adminSession);

    if (isImpersonating) {
      const adminDomain = (process.env.ADMIN_EMAIL_DOMAIN || "iq-rest.com").toLowerCase();
      if (!adminEmail!.toLowerCase().endsWith("@" + adminDomain)) {
        throw new UnauthorizedException();
      }
      const adminUser = await this.prisma.user.findUnique({ where: { email: adminEmail! } });
      if (!adminUser) throw new UnauthorizedException();
      const adminTokenHash = hashSessionToken(adminSession!);
      // Phase A dual-read: prefer multi-device sessions row, fall back to the
      // legacy User.sessionToken column for users who logged in before phase A.
      const adminSessionRow = await this.prisma.session.findUnique({ where: { tokenHash: adminTokenHash } });
      const adminSessionValid =
        (adminSessionRow && adminSessionRow.userId === adminUser.id && (adminSessionRow.expiresAt === null || adminSessionRow.expiresAt > new Date())) ||
        (adminUser.sessionToken !== null && safeCompare(adminUser.sessionToken, adminTokenHash));
      if (!adminSessionValid) throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { companies: { take: 1, include: { company: { select: { id: true, onboardingStep: true, createdAt: true } } } } },
    });
    if (!user) throw new UnauthorizedException();
    const company = user.companies[0]?.company;
    if (!company) throw new UnauthorizedException();

    if (!isImpersonating) {
      const tokenHash = hashSessionToken(cookieValue);
      const sessionRow = await this.prisma.session.findUnique({ where: { tokenHash } });
      const sessionRowValid =
        sessionRow !== null && sessionRow.userId === user.id && (sessionRow.expiresAt === null || sessionRow.expiresAt > new Date());
      const legacyValid =
        user.sessionToken !== null && safeCompare(user.sessionToken, tokenHash);
      if (!sessionRowValid && !legacyValid) {
        throw new UnauthorizedException();
      }
    }

    return {
      userId: user.id,
      companyId: company.id,
      email: user.email,
      onboardingStep: company.onboardingStep,
      legacyDashboard: isLegacyEmail(user.email),
    };
  }

  async logout(email: string | undefined, cookieValue?: string): Promise<void> {
    if (!email) return;
    if (cookieValue) {
      const tokenHash = hashSessionToken(cookieValue);
      await this.prisma.session.deleteMany({ where: { tokenHash } }).catch(() => undefined);
      // Legacy compat: if this token was the User.sessionToken (logged in
      // before phase A), clear it too. Otherwise leave it — it belongs to a
      // different device that should remain logged in.
      await this.prisma.user.updateMany({
        where: { email, sessionToken: tokenHash },
        data: { sessionToken: null },
      }).catch(() => undefined);
    } else {
      // No token in cookie: nuke everything for this user (defensive).
      const u = await this.prisma.user.findUnique({ where: { email }, select: { id: true } }).catch(() => null);
      if (u) await this.prisma.session.deleteMany({ where: { userId: u.id } }).catch(() => undefined);
      await this.prisma.user.update({ where: { email }, data: { sessionToken: null } }).catch(() => undefined);
    }
  }

  /** Exchange an authorization code (from accounts.oauth2.initCodeClient popup flow)
   *  for an id_token. Uses redirect_uri="postmessage" because the popup hands the
   *  code back via window.postMessage rather than a redirect. */
  /** Exchange a Google authorization code for an id_token.
   *  redirectUri defaults to "postmessage" (popup ux_mode); pass the actual
   *  callback URL when using a full-page redirect flow — Google validates it
   *  must match the one used to obtain the code. */
  async exchangeGoogleCode(code: string, redirectUri = "postmessage"): Promise<string> {
    const clientId = this.config.get<string>("GOOGLE_CLIENT_ID");
    const clientSecret =
      this.config.get<string>("GOOGLE_CLIENT_SECRET") ||
      this.config.get<string>("GOOGLE_ADS_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      throw new HttpException("Google auth not configured", HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const { OAuth2Client } = await import("google-auth-library");
    const oauth = new OAuth2Client(clientId, clientSecret, redirectUri);
    try {
      const { tokens } = await oauth.getToken(code);
      if (!tokens.id_token) throw new BadRequestException("Google did not return id_token");
      return tokens.id_token;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException("Invalid Google authorization code");
    }
  }

  async verifyGoogleCredential(
    credential: string,
    signupContext?: SignupContext,
    currency?: string,
    locale?: string | null,
  ): Promise<{
    token: string;
    userId: string;
    email: string;
    onboardingStep: number;
    isNewUser: boolean;
    legacyDashboard: boolean;
  }> {
    if (!credential) throw new BadRequestException("Missing credential");
    const clientId = this.config.get<string>("GOOGLE_CLIENT_ID");
    if (!clientId) throw new HttpException("Google auth not configured", HttpStatus.INTERNAL_SERVER_ERROR);

    const { OAuth2Client } = await import("google-auth-library");
    const oauth = new OAuth2Client(clientId);
    let payload: { email?: string; name?: string } | undefined;
    try {
      const ticket = await oauth.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload() as { email?: string; name?: string } | undefined;
    } catch {
      throw new BadRequestException("Invalid Google token");
    }
    if (!payload?.email) throw new BadRequestException("Invalid Google token");

    const email = payload.email.trim().toLowerCase();
    const displayName = payload.name || email.split("@")[0];

    let user = await this.prisma.user.findUnique({
      where: { email },
      include: { companies: { take: 1, include: { company: { select: { id: true, onboardingStep: true, createdAt: true } } } } },
    });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const normalizedLocale = locale ? this.i18n.urlLocale(locale) : null;
      const created = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: { email, ...(normalizedLocale ? { preferredLocale: normalizedLocale } : {}) },
        });
        const company = await tx.company.create({
          data: {
            name: displayName,
            onboardingStep: 0,
            trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          },
        });
        await tx.userCompany.create({
          data: { userId: newUser.id, companyId: company.id, role: "owner" },
        });
        return newUser;
      });
      user = await this.prisma.user.findUnique({
        where: { id: created.id },
        include: { companies: { take: 1, include: { company: { select: { id: true, onboardingStep: true, createdAt: true } } } } },
      });
    }

    if (!user) throw new HttpException("Failed to load user", HttpStatus.INTERNAL_SERVER_ERROR);

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    // Stash the signup context on the user row so the seeder can pick it up
    // in the same code path as the OTP flow (single source of truth).
    // Brand-new Google account with no create-flow context → use the default template.
    let pending = this.normalizeSignupContext(signupContext, currency);
    if (isNewUser && Object.keys(pending).length === 0) {
      pending = this.defaultSignupContext(email, currency);
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionToken: tokenHash, ...pending },
    });
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    const seeded = await this.applyPendingAndMaybeSeed(user.id, locale ?? null);
    const finalStep = seeded ? 3 : user.companies[0]?.company?.onboardingStep ?? 0;
    const legacyDashboard = isLegacyEmail(email);
    return { token, userId: user.id, email, onboardingStep: finalStep, isNewUser, legacyDashboard };
  }

  private appleConfig(): import("./apple-auth").AppleConfig {
    const teamId = this.config.get<string>("APPLE_TEAM_ID");
    const keyId = this.config.get<string>("APPLE_KEY_ID");
    const servicesId = this.config.get<string>("APPLE_SERVICES_ID");
    const privateKey = this.config.get<string>("APPLE_PRIVATE_KEY");
    if (!teamId || !keyId || !servicesId || !privateKey) {
      throw new HttpException("Apple auth not configured", HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return { teamId, keyId, servicesId, privateKey };
  }

  /** Exchange an Apple authorization code for an id_token. The redirect URI
   *  must byte-match the one registered on the Services ID and used in the
   *  authorize request. */
  async exchangeAppleCode(code: string, redirectUri: string): Promise<string> {
    const { exchangeAppleCode } = await import("./apple-auth");
    try {
      return await exchangeAppleCode(this.appleConfig(), code, redirectUri);
    } catch {
      throw new BadRequestException("Invalid Apple authorization code");
    }
  }

  /** Mirror of verifyGoogleCredential for Sign in with Apple. Verifies the
   *  id_token, then runs the exact same find-or-create + session-issue path.
   *  `displayName` carries the name Apple only sends on the FIRST sign-in
   *  (parsed from the form_post `user` field); it seeds the company name for
   *  brand-new accounts and is ignored thereafter. */
  async verifyAppleCredential(
    idToken: string,
    displayName: string | null,
    signupContext?: SignupContext,
    currency?: string,
    locale?: string | null,
  ): Promise<{
    token: string;
    userId: string;
    email: string;
    onboardingStep: number;
    isNewUser: boolean;
    legacyDashboard: boolean;
  }> {
    if (!idToken) throw new BadRequestException("Missing credential");
    const { verifyAppleIdToken } = await import("./apple-auth");
    let identity: import("./apple-auth").AppleIdentity;
    try {
      identity = await verifyAppleIdToken(this.appleConfig(), idToken);
    } catch {
      throw new BadRequestException("Invalid Apple token");
    }
    if (!identity.email) throw new BadRequestException("Invalid Apple token");

    const email = identity.email.trim().toLowerCase();
    const companyName = (displayName && displayName.trim()) || email.split("@")[0];

    let user = await this.prisma.user.findUnique({
      where: { email },
      include: { companies: { take: 1, include: { company: { select: { id: true, onboardingStep: true, createdAt: true } } } } },
    });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const normalizedLocale = locale ? this.i18n.urlLocale(locale) : null;
      const created = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: { email, ...(normalizedLocale ? { preferredLocale: normalizedLocale } : {}) },
        });
        const company = await tx.company.create({
          data: {
            name: companyName,
            onboardingStep: 0,
            trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          },
        });
        await tx.userCompany.create({
          data: { userId: newUser.id, companyId: company.id, role: "owner" },
        });
        return newUser;
      });
      user = await this.prisma.user.findUnique({
        where: { id: created.id },
        include: { companies: { take: 1, include: { company: { select: { id: true, onboardingStep: true, createdAt: true } } } } },
      });
    }

    if (!user) throw new HttpException("Failed to load user", HttpStatus.INTERNAL_SERVER_ERROR);

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    let pending = this.normalizeSignupContext(signupContext, currency);
    if (isNewUser && Object.keys(pending).length === 0) {
      pending = this.defaultSignupContext(email, currency);
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { sessionToken: tokenHash, ...pending },
    });
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    const seeded = await this.applyPendingAndMaybeSeed(user.id, locale ?? null);
    const finalStep = seeded ? 3 : user.companies[0]?.company?.onboardingStep ?? 0;
    const legacyDashboard = isLegacyEmail(email);
    return { token, userId: user.id, email, onboardingStep: finalStep, isNewUser, legacyDashboard };
  }
}
