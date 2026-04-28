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
  list(@Req() req: Request, @Query("status") status?: string) {
    return this.svc.list((req as AuthedRequest).authUser.companyId, status);
  }

  @Post()
  create(@Req() req: Request, @Body() body: Parameters<OrdersService["create"]>[1]) {
    return this.svc.create((req as AuthedRequest).authUser.companyId, body);
  }

  @Patch(":id")
  patch(@Req() req: Request, @Param("id") id: string, @Body() body: Parameters<OrdersService["patch"]>[2]) {
    return this.svc.patch((req as AuthedRequest).authUser.companyId, id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove((req as AuthedRequest).authUser.companyId, id);
  }
}
