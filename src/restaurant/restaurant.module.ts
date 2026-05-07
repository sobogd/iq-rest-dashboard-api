import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AutoTranslateModule } from "../auto-translate/auto-translate.module";
import { RestaurantController } from "./restaurant.controller";
import { RestaurantService } from "./restaurant.service";

@Module({
  imports: [AuthModule, AutoTranslateModule],
  controllers: [RestaurantController],
  providers: [RestaurantService],
})
export class RestaurantModule {}
