import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  forwardRef,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { DevicesService } from "./devices.service";
import { DeviceGuard, DevicedRequest } from "./device.guard";
import { CreateDeviceDto, PairDeviceDto } from "./dto";
import { OrdersService } from "../orders/orders.service";
import { PrismaService } from "../prisma/prisma.service";

@Controller("devices")
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Admin (signed-in user via cookie session) ───────────────────────────

  @UseGuards(AuthGuard)
  @Get()
  list(@Req() req: AuthedRequest) {
    return this.devices.list(req.authUser.companyId);
  }

  @UseGuards(AuthGuard)
  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateDeviceDto) {
    return this.devices.create({
      companyId: req.authUser.companyId,
      restaurantId: req.authUser.restaurantId,
      name: dto.name,
      type: dto.type,
      overrideRestaurantId: dto.restaurantId,
    });
  }

  @UseGuards(AuthGuard)
  @Post(":id/regenerate-code")
  regenerate(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.devices.regenerateCode(req.authUser.companyId, id);
  }

  @UseGuards(AuthGuard)
  @Post(":id/revoke")
  revoke(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.devices.revoke(req.authUser.companyId, id);
  }

  @UseGuards(AuthGuard)
  @Delete(":id")
  remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.devices.remove(req.authUser.companyId, id);
  }

  // ── Public: pair (no auth — the 6-digit code is the credential) ─────────

  @Post("pair")
  async pair(@Body() dto: PairDeviceDto, @Req() req: Request) {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.ip;
    return this.devices.pair(dto.code, ip);
  }

  // ── Device (Bearer token) ───────────────────────────────────────────────

  // Single snapshot endpoint for the kitchen UI on boot. Returns everything
  // KitchenPage needs (restaurant + menu + active orders + tables) so the
  // tablet doesn't have to make five parallel calls before it can render.
  // Subsequent live updates ride on the /devices/stream SSE.
  @UseGuards(DeviceGuard)
  @Get("bootstrap")
  async bootstrap(@Req() req: DevicedRequest) {
    const { restaurantId, companyId } = req.device;
    const [restaurant, categories, items, tables, orders] = await Promise.all([
      this.prisma.restaurant.findUnique({ where: { id: restaurantId } }),
      this.prisma.category.findMany({
        where: { restaurantId, isActive: true },
        orderBy: { sortOrder: "asc" },
      }),
      this.prisma.item.findMany({
        where: { restaurantId, isActive: true, deletedAt: null },
        orderBy: { sortOrder: "asc" },
      }),
      this.prisma.table.findMany({
        where: { restaurantId, isActive: true, deletedAt: null },
        orderBy: { sortOrder: "asc" },
      }),
      this.orders.list({ companyId, restaurantId }, undefined, undefined, undefined),
    ]);
    if (!restaurant) {
      throw new BadRequestException("Restaurant not found");
    }
    return {
      device: {
        id: req.device.deviceId,
        type: req.device.type,
        restaurantId: req.device.restaurantId,
      },
      restaurant,
      categories,
      items,
      tables,
      orders,
    };
  }

  @UseGuards(DeviceGuard)
  @Get("me")
  async me(@Req() req: DevicedRequest) {
    await this.devices.heartbeat(req.device.deviceId);
    return {
      deviceId: req.device.deviceId,
      restaurantId: req.device.restaurantId,
      companyId: req.device.companyId,
      type: req.device.type,
    };
  }

  // Kitchen-scoped order PATCH. Lets a paired tablet advance per-item statuses
  // without exposing the full /orders/:id surface (which can change payment
  // method, close an order, mutate tableNumber, etc.). The body shape is
  // hard-restricted to {items, total} — anything else is rejected.
  @UseGuards(DeviceGuard)
  @Patch("orders/:id")
  async patchOrder(
    @Req() req: DevicedRequest,
    @Param("id") id: string,
    @Body() body: { items?: unknown[]; total?: number },
  ) {
    const allowed = new Set(["items", "total"]);
    for (const key of Object.keys(body || {})) {
      if (!allowed.has(key)) {
        throw new BadRequestException(`Field not allowed for devices: ${key}`);
      }
    }
    if (!Array.isArray(body.items)) {
      throw new BadRequestException("items array required");
    }
    return this.orders.patch(
      { companyId: req.device.companyId, restaurantId: req.device.restaurantId },
      id,
      { items: body.items, total: body.total },
    );
  }
}
