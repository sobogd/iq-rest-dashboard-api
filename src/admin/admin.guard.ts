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
    const req = ctx.switchToHttp().getRequest<Request>();
    const path = (req.path || req.originalUrl || req.url || "").split("?")[0];

    // Everyone hitting the admin module must still hold a valid session.
    const ok = await this.authGuard.canActivate(ctx);
    if (!ok) return false;

    // POST /api/admin/impersonate/exit must work while impersonating — the
    // current user is the target (not an admin). Skip only the admin-email
    // check; the endpoint itself validates the admin_original_* cookies.
    if (path === "/admin/impersonate/exit" || path === "/api/admin/impersonate/exit") {
      return true;
    }

    const email = (req as AuthedRequest).authUser?.email;
    if (!isAdminEmail(email)) {
      throw new ForbiddenException("Admin access required");
    }
    return true;
  }
}
