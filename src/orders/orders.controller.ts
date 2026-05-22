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
import { OrdersService } from "./orders.service";

function ctx(req: Request) {
  const { companyId, restaurantId } = (req as AuthedRequest).authUser;
  return { companyId, restaurantId };
}

@Controller("orders")
@UseGuards(UserOrDeviceGuard)
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get()
  list(
    @Req() req: Request,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.svc.list(ctx(req), status, from, to);
  }

  @Post()
  create(@Req() req: Request, @Body() body: Parameters<OrdersService["create"]>[1]) {
    return this.svc.create(ctx(req), body);
  }

  @Patch(":id")
  patch(@Req() req: Request, @Param("id") id: string, @Body() body: Parameters<OrdersService["patch"]>[2]) {
    return this.svc.patch(ctx(req), id, body);
  }

  @Post(":id/split")
  split(@Req() req: Request, @Param("id") id: string, @Body() body: Parameters<OrdersService["split"]>[2]) {
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
