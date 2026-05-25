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
import type { AuthedRequest } from "../auth/auth.guard";
import { UserOrDeviceGuard } from "../devices/user-or-device.guard";
import { ReservationsService } from "./reservations.service";
import { SetStatusDto } from "./dto";

// Dual auth: cookie-session admin OR a paired device token. Mirrors
// OrdersController so the same ReservationsPage renders in both the admin
// tab and the RESERVATION kiosk.
@Controller("reservations")
@UseGuards(UserOrDeviceGuard)
export class ReservationsController {
  constructor(private readonly svc: ReservationsService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list((req as AuthedRequest).authUser.restaurantId);
  }

  @Patch(":id")
  setStatus(@Req() req: Request, @Param("id") id: string, @Body() body: SetStatusDto) {
    return this.svc.setStatus((req as AuthedRequest).authUser.restaurantId, id, body.status);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param("id") id: string) {
    await this.svc.remove((req as AuthedRequest).authUser.restaurantId, id);
  }
}
