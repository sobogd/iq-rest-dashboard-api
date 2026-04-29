import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { SendOtpDto, VerifyOtpDto } from "./dto";
import { authCookieOptions } from "../common/session-utils";

const SESSION_COOKIE = "iqr_session";
const EMAIL_COOKIE = "iqr_email";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  @Post("send-otp")
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() dto: SendOtpDto) {
    const result = await this.auth.sendOtp(dto.email, dto.locale || "en");
    return { ok: true, isNewUser: result.isNewUser };
  }

  @Post("verify-otp")
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto, @Res({ passthrough: true }) res: Response) {
    const { token, onboardingStep, isNewUser } = await this.auth.verifyOtp(dto.email, dto.code);
    const domain = this.config.get<string>("COOKIE_DOMAIN") || undefined;
    const opts = authCookieOptions(domain);
    res.cookie(SESSION_COOKIE, token, opts);
    res.cookie(EMAIL_COOKIE, dto.email, { ...opts, httpOnly: false });
    return { ok: true, onboardingStep, isNewUser };
  }

  @Post("google")
  @HttpCode(HttpStatus.OK)
  async google(@Body() body: { credential?: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.verifyGoogleCredential(body.credential || "");
    const domain = this.config.get<string>("COOKIE_DOMAIN") || undefined;
    const opts = authCookieOptions(domain);
    res.cookie(SESSION_COOKIE, result.token, opts);
    res.cookie(EMAIL_COOKIE, result.email, { ...opts, httpOnly: false });
    return {
      ok: true,
      email: result.email,
      userId: result.userId,
      onboardingStep: result.onboardingStep,
      isNewUser: result.isNewUser,
    };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const email = req.cookies?.[EMAIL_COOKIE];
    await this.auth.logout(email);
    const domain = this.config.get<string>("COOKIE_DOMAIN") || undefined;
    const baseOpts = { path: "/", ...(domain ? { domain } : {}) };
    res.clearCookie(SESSION_COOKIE, baseOpts);
    res.clearCookie(EMAIL_COOKIE, baseOpts);
    return { ok: true };
  }

  @Get("check")
  async check(@Req() req: Request) {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const session = cookies?.[SESSION_COOKIE];
    const email = cookies?.[EMAIL_COOKIE];
    if (!session || !email) return { authenticated: false };
    const adminOrigSession = cookies?.["iqr_admin_original_session"];
    const adminOrigEmail = cookies?.["iqr_admin_original_email"];
    try {
      const user = await this.auth.resolveSession(session, email, {
        adminOrigSession,
        adminOrigEmail,
      });
      return {
        authenticated: true,
        email: user.email,
        userId: user.userId,
        companyId: user.companyId,
        onboardingStep: user.onboardingStep,
        impersonatedBy: adminOrigEmail || null,
      };
    } catch {
      return { authenticated: false };
    }
  }
}
