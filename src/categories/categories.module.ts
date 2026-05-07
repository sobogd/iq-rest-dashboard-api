import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AutoTranslateModule } from "../auto-translate/auto-translate.module";
import { CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";

@Module({
  imports: [AuthModule, AutoTranslateModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
})
export class CategoriesModule {}
