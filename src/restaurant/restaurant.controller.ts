import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { RestaurantService } from "./restaurant.service";

@Controller("restaurant")
@UseGuards(AuthGuard)
export class RestaurantController {
  constructor(private readonly svc: RestaurantService) {}

  @Get()
  async get(@Req() req: Request) {
    const { companyId } = (req as AuthedRequest).authUser;
    return this.svc.getByCompany(companyId);
  }

  @Post()
  async upsert(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const { companyId } = (req as AuthedRequest).authUser;
    return this.svc.upsert(companyId, body);
  }
}
