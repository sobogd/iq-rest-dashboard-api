import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import { PrismaService } from "../prisma/prisma.service";

const SESSION_COOKIE = "iqr_session";
const EMAIL_COOKIE = "iqr_email";
const ADMIN_ORIG_SESSION_COOKIE = "iqr_admin_original_session";
const ADMIN_ORIG_EMAIL_COOKIE = "iqr_admin_original_email";
const ACTIVE_RESTAURANT_COOKIE = "iqr_active_restaurant_id";
const ACTIVE_RESTAURANT_HEADER = "x-restaurant-id";

export interface AuthedRequest extends Request {
  authUser: {
    userId: string;
    companyId: string;
    email: string;
    onboardingStep: number;
    restaurantId: string;
    primaryRestaurantId: string;
  };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

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

    const requested =
      (req.headers[ACTIVE_RESTAURANT_HEADER] as string | undefined) ||
      cookies?.[ACTIVE_RESTAURANT_COOKIE];
    const { activeId, primaryId } = await this.resolveActiveRestaurant(
      user.companyId,
      requested,
    );

    (req as AuthedRequest).authUser = {
      userId: user.userId,
      companyId: user.companyId,
      email: user.email,
      onboardingStep: user.onboardingStep,
      restaurantId: activeId,
      primaryRestaurantId: primaryId,
    };
    return true;
  }

  private async resolveActiveRestaurant(
    companyId: string,
    requested: string | undefined,
  ): Promise<{ activeId: string; primaryId: string }> {
    const restaurants = await this.prisma.restaurant.findMany({
      where: { companyId },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    if (restaurants.length === 0) {
      throw new UnauthorizedException("No restaurant for company");
    }
    const primaryId = restaurants[0].id;
    if (requested && restaurants.some((r) => r.id === requested)) {
      return { activeId: requested, primaryId };
    }
    return { activeId: primaryId, primaryId };
  }
}
