import { Module } from "@nestjs/common";
import { AutoTranslateService } from "./auto-translate.service";

@Module({
  providers: [AutoTranslateService],
  exports: [AutoTranslateService],
})
export class AutoTranslateModule {}
