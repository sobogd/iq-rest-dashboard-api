import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { DevicesService, DeviceAuth } from "./devices.service";

export interface DevicedRequest extends Request {
  device: DeviceAuth;
}

export function extractBearer(req: Request): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m?.[1];
}

@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(private readonly devices: DevicesService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedException();
    const auth = await this.devices.resolveByToken(token);
    (req as DevicedRequest).device = auth;
    return true;
  }
}
