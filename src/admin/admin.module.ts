import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MailModule } from "../mail/mail.module";
import { DevicesModule } from "../devices/devices.module";
import { RestaurantModule } from "../restaurant/restaurant.module";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";

@Module({
  imports: [AuthModule, MailModule, DevicesModule, RestaurantModule],
  controllers: [AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}
