import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { type AuthedRequest } from "../auth/auth.guard";
import { UserOrDeviceGuard } from "../devices/user-or-device.guard";
import { DeviceTypes } from "../devices/device-types.decorator";
import { OrdersService } from "./orders.service";
import { CreateOrderDto, PatchOrderDto, SplitOrderDto } from "./dto";

function ctx(req: Request) {
  const { companyId, restaurantId } = (req as AuthedRequest).authUser;
  return { companyId, restaurantId };
}

// Cookie-session admin OR a paired WAITER device. KITCHEN/RESERVATION tokens
// are rejected here (KITCHEN flips item statuses via the locked-down
// /devices/orders/:id; RESERVATION has no business on the orders surface).
@Controller("orders")
@UseGuards(UserOrDeviceGuard)
@DeviceTypes("WAITER")
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get()
  list(
    @Req() req: Request,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("open") open?: string,
  ) {
    return this.svc.list(ctx(req), status, from, to, open === "1" || open === "true");
  }

  @Post()
  create(@Req() req: Request, @Body() body: CreateOrderDto) {
    return this.svc.create(ctx(req), body);
  }

  @Patch(":id")
  patch(@Req() req: Request, @Param("id") id: string, @Body() body: PatchOrderDto) {
    return this.svc.patch(ctx(req), id, body);
  }

  @Post(":id/split")
  split(@Req() req: Request, @Param("id") id: string, @Body() body: SplitOrderDto) {
    return this.svc.split(ctx(req), id, body);
  }

  @Post(":id/reopen")
  reopen(@Req() req: Request, @Param("id") id: string) {
    return this.svc.reopen(ctx(req), id);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove(ctx(req), id);
  }
}
