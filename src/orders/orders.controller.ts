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
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { OrdersService } from "./orders.service";

@Controller("orders")
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get()
  list(
    @Req() req: Request,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.svc.list((req as AuthedRequest).authUser.companyId, status, from, to);
  }

  @Post()
  create(@Req() req: Request, @Body() body: Parameters<OrdersService["create"]>[1]) {
    return this.svc.create((req as AuthedRequest).authUser.companyId, body);
  }

  @Patch(":id")
  patch(@Req() req: Request, @Param("id") id: string, @Body() body: Parameters<OrdersService["patch"]>[2]) {
    return this.svc.patch((req as AuthedRequest).authUser.companyId, id, body);
  }

  @Post(":id/split")
  split(@Req() req: Request, @Param("id") id: string, @Body() body: Parameters<OrdersService["split"]>[2]) {
    return this.svc.split((req as AuthedRequest).authUser.companyId, id, body);
  }

  @Post(":id/reopen")
  reopen(@Req() req: Request, @Param("id") id: string) {
    return this.svc.reopen((req as AuthedRequest).authUser.companyId, id);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove((req as AuthedRequest).authUser.companyId, id);
  }
}
