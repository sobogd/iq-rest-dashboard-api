import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard";
import { ReservationsService } from "./reservations.service";

@Controller("reservations")
@UseGuards(AuthGuard)
export class ReservationsController {
  constructor(private readonly svc: ReservationsService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list((req as AuthedRequest).authUser.companyId);
  }

  @Patch(":id")
  setStatus(@Req() req: Request, @Param("id") id: string, @Body() body: { status: string }) {
    return this.svc.setStatus((req as AuthedRequest).authUser.companyId, id, body.status);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove((req as AuthedRequest).authUser.companyId, id);
  }
}
