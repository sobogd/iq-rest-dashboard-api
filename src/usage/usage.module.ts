import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UsageController } from "./usage.controller";
import { UsageCleanupService } from "./usage-cleanup.service";

@Module({
  imports: [AuthModule],
  controllers: [UsageController],
  providers: [UsageCleanupService],
})
export class UsageModule {}
