import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TranslateController } from "./translate.controller";

@Module({
  imports: [AuthModule],
  controllers: [TranslateController],
})
export class TranslateModule {}
