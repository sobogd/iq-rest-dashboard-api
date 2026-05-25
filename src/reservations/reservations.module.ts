import { forwardRef, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OrdersStreamModule } from "../orders-stream/orders-stream.module";
import { DevicesModule } from "../devices/devices.module";
import { ReservationsController } from "./reservations.controller";
import { ReservationsService } from "./reservations.service";

@Module({
  imports: [AuthModule, OrdersStreamModule, forwardRef(() => DevicesModule)],
  controllers: [ReservationsController],
  providers: [ReservationsService],
})
export class ReservationsModule {}
