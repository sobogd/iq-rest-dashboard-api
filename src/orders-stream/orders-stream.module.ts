import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OrdersEventsService } from "./orders-events.service";
import { OrdersStreamController } from "./orders-stream.controller";

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [OrdersStreamController],
  providers: [OrdersEventsService],
  exports: [OrdersEventsService],
})
export class OrdersStreamModule {}
