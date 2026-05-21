import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { TablesService } from "./tables.service";

@Controller("tables")
@UseGuards(AuthGuard)
export class TablesController {
  constructor(private readonly svc: TablesService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list((req as AuthedRequest).authUser.restaurantId);
  }

  @Post()
  create(@Req() req: Request, @Body() body: Parameters<TablesService["create"]>[1]) {
    return this.svc.create((req as AuthedRequest).authUser.restaurantId, body);
  }

  @Put(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: Parameters<TablesService["update"]>[2]) {
    return this.svc.update((req as AuthedRequest).authUser.restaurantId, id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove((req as AuthedRequest).authUser.restaurantId, id);
  }
}
