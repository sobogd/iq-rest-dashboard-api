import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";

const SESSION_COOKIE = "iqr_session";
const EMAIL_COOKIE = "iqr_email";
const ADMIN_ORIG_SESSION_COOKIE = "iqr_admin_original_session";
const ADMIN_ORIG_EMAIL_COOKIE = "iqr_admin_original_email";

export interface AuthedRequest extends Request {
  authUser: { userId: string; companyId: string; email: string; onboardingStep: number };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const session = cookies?.[SESSION_COOKIE];
    const email = cookies?.[EMAIL_COOKIE];
    if (!session || !email) throw new UnauthorizedException();
    const adminOrigSession = cookies?.[ADMIN_ORIG_SESSION_COOKIE];
    const adminOrigEmail = cookies?.[ADMIN_ORIG_EMAIL_COOKIE];
    const user = await this.auth.resolveSession(session, email, {
      adminOrigSession,
      adminOrigEmail,
    });
    (req as AuthedRequest).authUser = user;
    return true;
  }
}
