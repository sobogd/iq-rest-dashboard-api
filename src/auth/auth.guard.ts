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
    // Active company context. Per-restaurant billing model — companyId is
    // derived from the chosen restaurant for backward compatibility with the
    // services that still scope by company (Categories/Items/Orders/etc.).
    companyId: string;
    email: string;
    onboardingStep: number;
    restaurantId: string;
    primaryRestaurantId: string;
    // Mirror of companyId in the per-restaurant model. Retained for code
    // paths that still distinguish "user's own company" from "active context"
    // (no-op now — they always match).
    ownCompanyId: string;
    // True when the active restaurant attachment was created by someone else
    // (RestaurantUser.addedBy is non-null). The original creator of a
    // restaurant has addedBy = null. Gates billing/delete on attached-as-
    // manager restaurants.
    viaGrant: boolean;
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
    const { activeId, primaryId, companyId, viaGrant } =
      await this.resolveActiveRestaurant(user.userId, user.companyId, requested);

    (req as AuthedRequest).authUser = {
      userId: user.userId,
      companyId,
      email: user.email,
      onboardingStep: user.onboardingStep,
      restaurantId: activeId,
      primaryRestaurantId: primaryId,
      ownCompanyId: companyId,
      viaGrant,
    };
    return true;
  }

  /** Resolve the active restaurant from the user's flat RestaurantUser
   *  attachments. Falls back to the legacy Company-derived path when the
   *  user has no RestaurantUser rows yet (mid-rollout edge case where
   *  backfill missed them or a brand-new signup hasn't been seeded). */
  private async resolveActiveRestaurant(
    userId: string,
    legacyCompanyId: string,
    requested: string | undefined,
  ): Promise<{ activeId: string; primaryId: string; companyId: string; viaGrant: boolean }> {
    const rus = await this.prisma.restaurantUser.findMany({
      where: { userId },
      select: {
        addedBy: true,
        addedAt: true,
        restaurant: { select: { id: true, companyId: true, createdAt: true } },
      },
      orderBy: { addedAt: "asc" },
    });

    if (rus.length > 0) {
      const primaryId = rus[0].restaurant.id;
      const chosen =
        (requested && rus.find((ru) => ru.restaurant.id === requested)) || rus[0];
      return {
        activeId: chosen.restaurant.id,
        primaryId,
        companyId: chosen.restaurant.companyId,
        viaGrant: !!chosen.addedBy,
      };
    }

    // Legacy fallback: user has no RestaurantUser row (backfill miss / brand
    // new signup pre-seed). Look up restaurants via the still-existing
    // Company + RestaurantAccess tables so onboarding stays unbroken.
    const [owned, granted] = await Promise.all([
      this.prisma.restaurant.findMany({
        where: { companyId: legacyCompanyId },
        select: { id: true, companyId: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.restaurantAccess.findMany({
        where: { userId },
        select: { restaurant: { select: { id: true, companyId: true, createdAt: true } } },
        orderBy: { restaurant: { createdAt: "asc" } },
      }),
    ]);
    const grantedRestaurants = granted.map((g) => g.restaurant);
    const all = [...owned, ...grantedRestaurants];
    if (all.length === 0) throw new UnauthorizedException("No restaurant for user");
    const primaryId = owned[0]?.id ?? grantedRestaurants[0].id;
    const chosen =
      (requested && all.find((r) => r.id === requested)) ||
      all.find((r) => r.id === primaryId) ||
      all[0];
    return {
      activeId: chosen.id,
      primaryId,
      companyId: chosen.companyId,
      viaGrant: chosen.companyId !== legacyCompanyId,
    };
  }
}
