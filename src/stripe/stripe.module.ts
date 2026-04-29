import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StripeController } from "./stripe.controller";

@Module({
  imports: [AuthModule],
  controllers: [StripeController],
})
export class StripeModule {}
