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
    // Active company context. For an owned restaurant this equals the user's
    // own company; for a granted restaurant it is the OWNER's company (derived
    // from the selected restaurant). All data scoping keys off this.
    companyId: string;
    email: string;
    onboardingStep: number;
    restaurantId: string;
    primaryRestaurantId: string;
    // The user's own company (companies[0]). Stays fixed regardless of which
    // restaurant is active. Used to tell owned vs granted restaurants apart.
    ownCompanyId: string;
    // True when the active restaurant was reached via a cross-company grant
    // (not owned by ownCompanyId). Gates billing management + delete.
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
      ownCompanyId: user.companyId,
      viaGrant,
    };
    return true;
  }

  // Resolve the active restaurant from the union of the user's OWN restaurants
  // (their company) and restaurants GRANTED to them across companies. The
  // active companyId is derived from the chosen restaurant: owned → own company
  // (unchanged from legacy behaviour); granted → owner's company. For any user
  // without grants this is identical to the old single-company resolution.
  private async resolveActiveRestaurant(
    userId: string,
    ownCompanyId: string,
    requested: string | undefined,
  ): Promise<{ activeId: string; primaryId: string; companyId: string; viaGrant: boolean }> {
    const [owned, granted] = await Promise.all([
      this.prisma.restaurant.findMany({
        where: { companyId: ownCompanyId },
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
    if (all.length === 0) {
      throw new UnauthorizedException("No restaurant for company");
    }
    // Primary stays an OWNED restaurant when one exists (keeps onboarding /
    // fallbacks pointed at the user's own company); pure contractors fall back
    // to their first grant.
    const primaryId = owned[0]?.id ?? grantedRestaurants[0].id;
    const chosen =
      (requested && all.find((r) => r.id === requested)) ||
      all.find((r) => r.id === primaryId) ||
      all[0];
    return {
      activeId: chosen.id,
      primaryId,
      companyId: chosen.companyId,
      viaGrant: chosen.companyId !== ownCompanyId,
    };
  }
}
