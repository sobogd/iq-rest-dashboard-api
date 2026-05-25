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
import { CreateCategoryDto, ReorderDto, UpdateCategoryDto } from "./dto";

function ctx(req: Request) {
  const { companyId, restaurantId } = (req as AuthedRequest).authUser;
  return { companyId, restaurantId };
}

@Controller("categories")
@UseGuards(AuthGuard)
export class CategoriesController {
  constructor(private readonly svc: CategoriesService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(ctx(req));
  }

  @Post()
  create(@Req() req: Request, @Body() body: CreateCategoryDto) {
    return this.svc.create(ctx(req), body);
  }

  @Put(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: UpdateCategoryDto) {
    return this.svc.update(ctx(req), id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove(ctx(req), id);
  }

  @Post("reorder")
  reorder(@Req() req: Request, @Body() body: ReorderDto) {
    return this.svc.reorder(ctx(req), body.items);
  }
}
