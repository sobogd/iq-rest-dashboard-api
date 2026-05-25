import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { DevicesService, type DeviceAuth } from "./devices.service";
import { extractBearer } from "./device.guard";
import { DEVICE_TYPES_KEY } from "./device-types.decorator";

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
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const bearer = extractBearer(req);
    if (bearer) {
      const auth = await this.devices.resolveByToken(bearer);
      // Per-route/-controller device-type allowlist. When set, a paired
      // device whose type isn't listed is rejected — so a KITCHEN tablet
      // can't drive the full /orders surface, nor a WAITER touch /reservations.
      const allowed = this.reflector.getAllAndOverride<DeviceAuth["type"][] | undefined>(
        DEVICE_TYPES_KEY,
        [ctx.getHandler(), ctx.getClass()],
      );
      if (allowed && !allowed.includes(auth.type)) {
        throw new ForbiddenException("device_type_not_allowed");
      }
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
