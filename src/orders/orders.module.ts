import { forwardRef, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OrdersStreamModule } from "../orders-stream/orders-stream.module";
import { DevicesModule } from "../devices/devices.module";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [AuthModule, OrdersStreamModule, forwardRef(() => DevicesModule)],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
