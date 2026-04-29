import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { TranslateController } from "./translate.controller";

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [TranslateController],
})
export class TranslateModule {}
