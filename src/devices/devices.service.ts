import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersEventsService } from "../orders-stream/orders-events.service";
import {
  generatePairingCode,
  signDeviceToken,
  verifyDeviceToken,
} from "./device-token";

const PAIRING_CODE_TTL_MS = 2 * 60 * 1000; // 120s
const PAIR_RATE_WINDOW_MS = 60 * 1000;
const PAIR_RATE_MAX = 20;

export interface DeviceAuth {
  deviceId: string;
  companyId: string;
  restaurantId: string;
  type: "KITCHEN" | "WAITER";
}

@Injectable()
export class DevicesService {
  // Per-IP throttle for the public pair endpoint. The endpoint itself is also
  // covered by the global ThrottlerGuard, but this tighter limit specifically
  // prevents 999_999-code enumeration attacks.
  private pairAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: OrdersEventsService,
  ) {}

  // ─── Admin: gating ────────────────────────────────────────────────────────
  //
  // Kitchen / waiter devices are a paid feature. Trial counts as paid (the
  // 14-day trial gives the customer full access to evaluate the product).

  private async assertCompanyMayUseDevices(companyId: string): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { plan: true, subscriptionStatus: true, trialEndsAt: true },
    });
    if (!company) throw new NotFoundException("Company not found");
    const isPaid =
      company.subscriptionStatus === "ACTIVE" &&
      !!company.plan &&
      company.plan !== "FREE";
    const inTrial = company.trialEndsAt !== null && company.trialEndsAt > new Date();
    if (!isPaid && !inTrial) {
      throw new ForbiddenException("devices_require_paid_plan");
    }
  }

  // ─── Admin: list ──────────────────────────────────────────────────────────

  async list(companyId: string) {
    const devices = await this.prisma.device.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
      include: { pairingCode: true },
    });
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      status: d.status,
      restaurantId: d.restaurantId,
      pairedAt: d.pairedAt?.toISOString() ?? null,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      pendingCode: this.pendingCode(d.pairingCode),
    }));
  }

  private pendingCode(code: { code: string; expiresAt: Date; usedAt: Date | null } | null) {
    if (!code || code.usedAt !== null) return null;
    if (code.expiresAt <= new Date()) return null;
    return { code: code.code, expiresAt: code.expiresAt.toISOString() };
  }

  // ─── Admin: create ─────────────────────────────────────────────────────────

  async create(input: {
    companyId: string;
    restaurantId: string; // active restaurant from AuthGuard
    name: string;
    type: "KITCHEN" | "WAITER";
    overrideRestaurantId?: string;
  }) {
    await this.assertCompanyMayUseDevices(input.companyId);

    let restaurantId = input.restaurantId;
    if (input.overrideRestaurantId && input.overrideRestaurantId !== restaurantId) {
      const ok = await this.prisma.restaurant.findFirst({
        where: { id: input.overrideRestaurantId, companyId: input.companyId },
        select: { id: true },
      });
      if (!ok) throw new BadRequestException("Invalid restaurant");
      restaurantId = input.overrideRestaurantId;
    }

    const device = await this.prisma.device.create({
      data: {
        companyId: input.companyId,
        restaurantId,
        name: input.name.trim(),
        type: input.type,
      },
    });
    const code = await this.issuePairingCode(device.id);
    return { ...(await this.detail(input.companyId, device.id)), pendingCode: code };
  }

  // ─── Admin: regenerate pairing code ───────────────────────────────────────

  async regenerateCode(companyId: string, deviceId: string) {
    const device = await this.requireOwned(companyId, deviceId);
    if (device.status === "REVOKED") {
      throw new BadRequestException("Device is revoked");
    }
    const code = await this.issuePairingCode(deviceId);
    return code;
  }

  private async issuePairingCode(deviceId: string) {
    // Collisions are extremely unlikely (10^6 space, very short TTL) but the
    // PK on `code` would error out; retry up to 5 times before giving up.
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    for (let i = 0; i < 5; i++) {
      const code = generatePairingCode();
      try {
        await this.prisma.pairingCode.upsert({
          where: { deviceId },
          create: { code, deviceId, expiresAt },
          update: { code, expiresAt, usedAt: null },
        });
        return { code, expiresAt: expiresAt.toISOString() };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          continue;
        }
        throw e;
      }
    }
    throw new BadRequestException("Failed to generate code, please retry");
  }

  // ─── Admin: revoke ─────────────────────────────────────────────────────────

  async revoke(companyId: string, deviceId: string) {
    const device = await this.requireOwned(companyId, deviceId);
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { status: "REVOKED", tokenVersion: { increment: 1 } },
    });
    // Tear down pending pairing code so the slot can't be used.
    await this.prisma.pairingCode.deleteMany({ where: { deviceId } });
    // Push to the tablet via the existing orders SSE so it reacts within
    // ~100ms instead of waiting for the next REST request to return 401.
    await this.events.publish({
      action: "device-revoked",
      restaurantId: device.restaurantId,
      deviceId,
    });
    return { ok: true };
  }

  // ─── Admin: delete ─────────────────────────────────────────────────────────

  async remove(companyId: string, deviceId: string) {
    const device = await this.requireOwned(companyId, deviceId);
    // Same effect as revoke for any currently-connected client (since the
    // token check below sees no row → 401).
    await this.prisma.device.delete({ where: { id: deviceId } });
    await this.events.publish({
      action: "device-revoked",
      restaurantId: device.restaurantId,
      deviceId,
    });
    return { ok: true };
  }

  private async requireOwned(companyId: string, deviceId: string) {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, companyId } });
    if (!device) throw new NotFoundException("Device not found");
    return device;
  }

  async detail(companyId: string, deviceId: string) {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, companyId },
      include: { pairingCode: true },
    });
    if (!device) throw new NotFoundException("Device not found");
    return {
      id: device.id,
      name: device.name,
      type: device.type,
      status: device.status,
      restaurantId: device.restaurantId,
      pairedAt: device.pairedAt?.toISOString() ?? null,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      createdAt: device.createdAt.toISOString(),
      pendingCode: this.pendingCode(device.pairingCode),
    };
  }

  // ─── Public: pair ──────────────────────────────────────────────────────────

  async pair(code: string, ip: string | undefined) {
    if (ip && this.rateLimitPair(ip)) {
      throw new BadRequestException("Too many attempts");
    }
    if (!/^[0-9]{6}$/.test(code)) {
      throw new BadRequestException("Invalid code");
    }

    const row = await this.prisma.pairingCode.findUnique({
      where: { code },
      include: { device: true },
    });
    if (!row || row.usedAt !== null || row.expiresAt <= new Date()) {
      throw new BadRequestException("Invalid or expired code");
    }
    if (row.device.status !== "ACTIVE") {
      throw new BadRequestException("Device is revoked");
    }

    // Re-check the gate at consume time too — a customer who downgraded after
    // generating a code shouldn't be able to spin up new tablets.
    await this.assertCompanyMayUseDevices(row.device.companyId);

    const now = new Date();
    const [device] = await this.prisma.$transaction([
      this.prisma.device.update({
        where: { id: row.deviceId },
        data: { pairedAt: row.device.pairedAt ?? now, lastSeenAt: now },
      }),
      this.prisma.pairingCode.update({
        where: { code },
        data: { usedAt: now },
      }),
    ]);

    const token = signDeviceToken({
      d: device.id,
      v: device.tokenVersion,
      iat: Math.floor(Date.now() / 1000),
    });

    return {
      token,
      device: {
        id: device.id,
        name: device.name,
        type: device.type,
        restaurantId: device.restaurantId,
      },
    };
  }

  private rateLimitPair(ip: string): boolean {
    const now = Date.now();
    const entry = this.pairAttempts.get(ip);
    if (!entry || now > entry.resetAt) {
      this.pairAttempts.set(ip, { count: 1, resetAt: now + PAIR_RATE_WINDOW_MS });
      return false;
    }
    entry.count++;
    return entry.count > PAIR_RATE_MAX;
  }

  // ─── Public: token verification (used by DeviceGuard) ─────────────────────

  async resolveByToken(token: string): Promise<DeviceAuth> {
    const payload = verifyDeviceToken(token);
    if (!payload) throw new UnauthorizedException();
    const device = await this.prisma.device.findUnique({
      where: { id: payload.d },
      select: {
        id: true,
        companyId: true,
        restaurantId: true,
        type: true,
        status: true,
        tokenVersion: true,
      },
    });
    if (!device) throw new UnauthorizedException();
    if (device.status !== "ACTIVE") throw new UnauthorizedException();
    if (device.tokenVersion !== payload.v) throw new UnauthorizedException();
    return {
      deviceId: device.id,
      companyId: device.companyId,
      restaurantId: device.restaurantId,
      type: device.type,
    };
  }

  // ─── Device: heartbeat ─────────────────────────────────────────────────────

  async heartbeat(deviceId: string) {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });
  }
}
