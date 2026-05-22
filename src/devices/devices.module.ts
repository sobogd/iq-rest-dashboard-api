import { forwardRef, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OrdersStreamModule } from "../orders-stream/orders-stream.module";
import { OrdersModule } from "../orders/orders.module";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { DeviceGuard } from "./device.guard";
import { DevicesStreamController } from "./devices-stream.controller";
import { UserOrDeviceGuard } from "./user-or-device.guard";

@Module({
  imports: [AuthModule, OrdersStreamModule, forwardRef(() => OrdersModule)],
  controllers: [DevicesController, DevicesStreamController],
  providers: [DevicesService, DeviceGuard, UserOrDeviceGuard],
  exports: [DevicesService, DeviceGuard, UserOrDeviceGuard],
})
export class DevicesModule {}
