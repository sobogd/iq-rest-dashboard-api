import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AutoTranslateModule } from "../auto-translate/auto-translate.module";
import { ItemsController } from "./items.controller";
import { ItemsService } from "./items.service";

@Module({
  imports: [AuthModule, AutoTranslateModule],
  controllers: [ItemsController],
  providers: [ItemsService],
})
export class ItemsModule {}
