import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UsageController } from "./usage.controller";

@Module({
  imports: [AuthModule],
  controllers: [UsageController],
})
export class UsageModule {}
