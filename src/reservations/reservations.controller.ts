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
import { DeviceTypes } from "../devices/device-types.decorator";
import { ReservationsService } from "./reservations.service";
import { SetStatusDto } from "./dto";

// Dual auth: cookie-session admin OR a paired RESERVATION device. KITCHEN /
// WAITER tokens are rejected — only the reservation board needs this surface.
@Controller("reservations")
@UseGuards(UserOrDeviceGuard)
@DeviceTypes("RESERVATION")
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
