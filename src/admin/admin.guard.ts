import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";

function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = (process.env.ADMIN_EMAIL_DOMAIN || "iq-rest.com").toLowerCase();
  return email.toLowerCase().endsWith("@" + domain);
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly authGuard: AuthGuard) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const ok = await this.authGuard.canActivate(ctx);
    if (!ok) return false;
    const req = ctx.switchToHttp().getRequest<Request>();
    const email = (req as AuthedRequest).authUser?.email;
    if (!isAdminEmail(email)) {
      throw new ForbiddenException("Admin access required");
    }
    return true;
  }
}
