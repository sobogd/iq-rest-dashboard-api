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

export interface AuthedRequest extends Request {
  authUser: { userId: string; companyId: string; email: string };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const session = req.cookies?.[SESSION_COOKIE];
    const email = req.cookies?.[EMAIL_COOKIE];
    if (!session || !email) throw new UnauthorizedException();
    const user = await this.auth.resolveSession(session, email);
    (req as AuthedRequest).authUser = user;
    return true;
  }
}
