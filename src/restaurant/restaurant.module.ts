import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AutoTranslateModule } from "../auto-translate/auto-translate.module";
import { OnboardingSeedModule } from "../onboarding/onboarding-seed.module";
import { RestaurantController } from "./restaurant.controller";
import { RestaurantService } from "./restaurant.service";

@Module({
  imports: [AuthModule, AutoTranslateModule, OnboardingSeedModule],
  controllers: [RestaurantController],
  providers: [RestaurantService],
  exports: [RestaurantService],
})
export class RestaurantModule {}
