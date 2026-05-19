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
import { GoogleAuthDto, SendOtpDto, VerifyOtpDto } from "./dto";
import { authCookieOptions } from "../common/session-utils";
import { getRequestCurrency } from "../common/geo";

const SESSION_COOKIE = "iqr_session";
const EMAIL_COOKIE = "iqr_email";
// Legacy monolith (iq-rest.com) reads these cookie names. We mirror the
// new API's cookies under the legacy names on the apex domain so that a
// user signing in on the new SPA stays signed in when redirected to the
// old dashboard (and vice versa).
const LEGACY_SESSION_COOKIE = "session";
const LEGACY_EMAIL_COOKIE = "user_email";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  @Post("send-otp")
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() dto: SendOtpDto, @Req() req: Request) {
    // Always detect currency — the seeder uses it both for create-flow signups and the
    // default-template fallback for plain-login new users.
    const currency = getRequestCurrency(req);
    const result = await this.auth.sendOtp(
      dto.email,
      dto.locale || "en",
      dto.signupContext,
      currency,
    );
    return { ok: true, isNewUser: result.isNewUser };
  }

  @Post("verify-otp")
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto, @Res({ passthrough: true }) res: Response) {
    const { token, onboardingStep, isNewUser, legacyDashboard } = await this.auth.verifyOtp(dto.email, dto.code);
    const domain = this.config.get<string>("COOKIE_DOMAIN") || undefined;
    const opts = authCookieOptions(domain);
    res.cookie(SESSION_COOKIE, token, opts);
    res.cookie(EMAIL_COOKIE, dto.email, { ...opts, httpOnly: false });
    res.cookie(LEGACY_SESSION_COOKIE, token, opts);
    res.cookie(LEGACY_EMAIL_COOKIE, dto.email, { ...opts, httpOnly: false });
    return { ok: true, onboardingStep, isNewUser, legacyDashboard };
  }

  @Post("google")
  @HttpCode(HttpStatus.OK)
  async google(@Body() body: GoogleAuthDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Prefer the app locale the SPA is currently on (sent in body) over the browser's
    // Accept-Language header — they often disagree (e.g. RU UI on a Chrome with en-US default).
    const acceptLang = req.headers["accept-language"]?.toString().split(",")[0]?.split("-")[0];
    const currency = getRequestCurrency(req);
    // Custom-button OAuth flow sends `code` from initCodeClient; legacy renderButton
    // flow sends `credential` (an id_token). Exchange code → id_token here so the
    // downstream verifier only deals with one shape.
    let credential = body.credential || "";
    if (!credential && body.code) {
      credential = await this.auth.exchangeGoogleCode(body.code);
    }
    const result = await this.auth.verifyGoogleCredential(
      credential,
      body.signupContext,
      currency,
      body.locale || acceptLang || null,
    );
    const domain = this.config.get<string>("COOKIE_DOMAIN") || undefined;
    const opts = authCookieOptions(domain);
    res.cookie(SESSION_COOKIE, result.token, opts);
    res.cookie(EMAIL_COOKIE, result.email, { ...opts, httpOnly: false });
    res.cookie(LEGACY_SESSION_COOKIE, result.token, opts);
    res.cookie(LEGACY_EMAIL_COOKIE, result.email, { ...opts, httpOnly: false });
    return {
      ok: true,
      email: result.email,
      userId: result.userId,
      onboardingStep: result.onboardingStep,
      isNewUser: result.isNewUser,
      legacyDashboard: result.legacyDashboard,
    };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const adminOrigEmail = cookies?.["iqr_admin_original_email"];
    // If inside impersonation, log out the admin (real user); otherwise the
    // user identified by iqr_email.
    const emailToLogOut = adminOrigEmail || cookies?.[EMAIL_COOKIE];
    const cookieToLogOut = cookies?.["iqr_admin_original_session"] || cookies?.[SESSION_COOKIE];
    await this.auth.logout(emailToLogOut, cookieToLogOut);
    const domain = this.config.get<string>("COOKIE_DOMAIN") || undefined;
    const baseOpts = { path: "/", ...(domain ? { domain } : {}) };
    res.clearCookie(SESSION_COOKIE, baseOpts);
    res.clearCookie(EMAIL_COOKIE, baseOpts);
    res.clearCookie(LEGACY_SESSION_COOKIE, baseOpts);
    res.clearCookie(LEGACY_EMAIL_COOKIE, baseOpts);
    res.clearCookie("iqr_admin_original_session", baseOpts);
    res.clearCookie("iqr_admin_original_email", baseOpts);
    res.clearCookie("iqr_admin_original_user_id", baseOpts);
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
        legacyDashboard: user.legacyDashboard,
        impersonatedBy: adminOrigEmail || null,
      };
    } catch {
      return { authenticated: false };
    }
  }
}
