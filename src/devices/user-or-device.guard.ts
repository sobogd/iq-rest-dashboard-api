import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { DevicesService } from "./devices.service";
import { DeviceGuard, extractBearer } from "./device.guard";

// Read-only dual-auth guard. Used on the kitchen-relevant read endpoints
// (orders list, categories, items, tables, restaurant) so the same SPA
// component renders for both an admin tab and a paired tablet without
// duplicating data routes.
//
// Resolution order: if the request carries `Authorization: Bearer ...` it is
// treated as a device. Otherwise it falls through to the cookie-based
// AuthGuard. The two paths populate `req.authUser` with the same shape so
// downstream controllers don't care which credential type came in.
@Injectable()
export class UserOrDeviceGuard implements CanActivate {
  constructor(
    private readonly devices: DevicesService,
    private readonly auth: AuthGuard,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const bearer = extractBearer(req);
    if (bearer) {
      const auth = await this.devices.resolveByToken(bearer);
      (req as AuthedRequest).authUser = {
        userId: `device:${auth.deviceId}`,
        companyId: auth.companyId,
        email: "",
        onboardingStep: 3,
        restaurantId: auth.restaurantId,
        primaryRestaurantId: auth.restaurantId,
      };
      // Heartbeat — fire-and-forget so a stalled write doesn't slow requests.
      void this.devices.heartbeat(auth.deviceId).catch(() => undefined);
      return true;
    }
    // Fall back to cookie auth. AuthGuard is a class instance from AuthModule
    // so we just delegate; it will populate req.authUser on success or throw.
    return this.auth.canActivate(ctx);
  }

  static unauthorized(): never {
    throw new UnauthorizedException();
  }
}
