import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OrdersStreamModule } from "../orders-stream/orders-stream.module";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [AuthModule, OrdersStreamModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
