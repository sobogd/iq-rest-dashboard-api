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
import { CategoriesService } from "./categories.service";

@Controller("categories")
@UseGuards(AuthGuard)
export class CategoriesController {
  constructor(private readonly svc: CategoriesService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list((req as AuthedRequest).authUser.companyId);
  }

  @Post()
  create(@Req() req: Request, @Body() body: { name: string; translations?: Record<string, { name: string }> | null; isActive?: boolean }) {
    return this.svc.create((req as AuthedRequest).authUser.companyId, body);
  }

  @Put(":id")
  update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { name?: string; translations?: Record<string, { name: string }> | null; isActive?: boolean; sortOrder?: number },
  ) {
    return this.svc.update((req as AuthedRequest).authUser.companyId, id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove((req as AuthedRequest).authUser.companyId, id);
  }

  @Post("reorder")
  reorder(@Req() req: Request, @Body() body: { items: { id: string; sortOrder: number }[] }) {
    return this.svc.reorder((req as AuthedRequest).authUser.companyId, body.items);
  }
}
