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
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { ItemsService } from "./items.service";

@Controller("items")
@UseGuards(AuthGuard)
export class ItemsController {
  constructor(private readonly svc: ItemsService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list((req as AuthedRequest).authUser.companyId);
  }

  @Post()
  create(@Req() req: Request, @Body() body: Parameters<ItemsService["create"]>[1]) {
    return this.svc.create((req as AuthedRequest).authUser.companyId, body);
  }

  @Put(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: Parameters<ItemsService["update"]>[2]) {
    return this.svc.update((req as AuthedRequest).authUser.companyId, id, body);
  }

  @Patch(":id")
  patch(@Req() req: Request, @Param("id") id: string, @Body() body: { isActive?: boolean }) {
    return this.svc.patch((req as AuthedRequest).authUser.companyId, id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove((req as AuthedRequest).authUser.companyId, id);
  }

  @Post("reorder")
  reorder(@Req() req: Request, @Body() body: { itemId: string; direction: "up" | "down" }) {
    return this.svc.reorder((req as AuthedRequest).authUser.companyId, body.itemId, body.direction);
  }
}
