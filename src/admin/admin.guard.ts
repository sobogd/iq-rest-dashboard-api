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
    // POST /api/admin/impersonate/exit must work while impersonating —
    // the current user is the target (not admin). Skip the admin email
    // check; the endpoint itself validates admin_original_* cookies.
    if (path.endsWith("/admin/impersonate/exit")) return true;

    const ok = await this.authGuard.canActivate(ctx);
    if (!ok) return false;
    const email = (req as AuthedRequest).authUser?.email;
    if (!isAdminEmail(email)) {
      throw new ForbiddenException("Admin access required");
    }
    return true;
  }
}
