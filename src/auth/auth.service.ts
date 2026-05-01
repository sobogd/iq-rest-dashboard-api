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

    await this.mail.sendOtp({ email, code, locale });
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

    if (!user || !user.otp || !user.otpExpiresAt) {
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

    // Success — issue session token.
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);

    await this.prisma.user.update({
      where: { email },
      data: {
        otp: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        sessionToken: tokenHash,
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
      if (!adminUser?.sessionToken) throw new UnauthorizedException();
      if (!safeCompare(adminUser.sessionToken, hashSessionToken(adminSession!))) {
        throw new UnauthorizedException();
      }
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { companies: { take: 1, include: { company: { select: { id: true, onboardingStep: true, createdAt: true } } } } },
    });
    if (!user) throw new UnauthorizedException();
    const company = user.companies[0]?.company;
    if (!company) throw new UnauthorizedException();

    if (!isImpersonating) {
      if (!user.sessionToken) throw new UnauthorizedException();
      if (!safeCompare(user.sessionToken, hashSessionToken(cookieValue))) {
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

  async logout(email: string | undefined): Promise<void> {
    if (!email) return;
    await this.prisma.user.update({
      where: { email },
      data: { sessionToken: null },
    }).catch(() => {});
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

    const seeded = await this.applyPendingAndMaybeSeed(user.id, locale ?? null);
    const finalStep = seeded ? 3 : user.companies[0]?.company?.onboardingStep ?? 0;
    const legacyDashboard = isLegacyEmail(email);
    return { token, userId: user.id, email, onboardingStep: finalStep, isNewUser, legacyDashboard };
  }
}
