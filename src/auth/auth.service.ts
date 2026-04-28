import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
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

const SEND_LIMIT_WINDOW = 15 * 60 * 1000;
const SEND_LIMIT_MAX = 5;
const VERIFY_LIMIT_WINDOW = 15 * 60 * 1000;
const VERIFY_LIMIT_MAX = 10;

@Injectable()
export class AuthService {
  private sendAttempts = new Map<string, { count: number; resetAt: number }>();
  private verifyAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

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

  async sendOtp(emailRaw: string, locale = "en"): Promise<{ isNewUser: boolean }> {
    const email = validateEmail(emailRaw);
    if (!email) throw new BadRequestException("Invalid email");

    if (this.rateLimit(this.sendAttempts, email, SEND_LIMIT_MAX, SEND_LIMIT_WINDOW)) {
      throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
    }

    const code = generateOTP();
    const otpHash = hashOTP(code);
    const otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

    let user = await this.prisma.user.findUnique({ where: { email } });
    let isNewUser = false;

    if (user) {
      await this.prisma.user.update({
        where: { email },
        data: { otp: otpHash, otpExpiresAt, otpAttempts: 0 },
      });
    } else {
      isNewUser = true;
      const companyName = locale === "es" ? "Mi Empresa" : "My Company";
      const company = await this.prisma.company.create({
        data: {
          name: companyName,
          onboardingStep: 0,
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
      try {
        user = await this.prisma.user.create({
          data: { email, otp: otpHash, otpExpiresAt, otpAttempts: 0 },
        });
        await this.prisma.userCompany.create({
          data: { userId: user.id, companyId: company.id, role: "owner" },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          // Race: another request created the user. Update OTP on existing.
          await this.prisma.user.update({
            where: { email },
            data: { otp: otpHash, otpExpiresAt, otpAttempts: 0 },
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

  async verifyOtp(emailRaw: string, code: string): Promise<{ token: string; userId: string; onboardingStep: number; isNewUser: boolean }> {
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

    const companyEdge = user.companies[0];
    const onboardingStep = companyEdge?.company?.onboardingStep ?? 0;
    return { token, userId: user.id, onboardingStep, isNewUser: !companyEdge?.company || onboardingStep < 3 };
  }

  /** Resolve user from session cookie. Throws Unauthorized when missing/invalid. */
  async resolveSession(cookieValue: string | undefined, email: string | undefined): Promise<{ userId: string; companyId: string; email: string }> {
    if (!cookieValue || !email) throw new UnauthorizedException();
    const tokenHash = hashSessionToken(cookieValue);
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { companies: { take: 1 } },
    });
    if (!user || !user.sessionToken) throw new UnauthorizedException();
    if (!safeCompare(user.sessionToken, tokenHash)) throw new UnauthorizedException();
    const companyId = user.companies[0]?.companyId;
    if (!companyId) throw new UnauthorizedException();
    return { userId: user.id, companyId, email: user.email };
  }

  async logout(email: string | undefined): Promise<void> {
    if (!email) return;
    await this.prisma.user.update({
      where: { email },
      data: { sessionToken: null },
    }).catch(() => {});
  }
}
