import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AnalyticsController } from "./analytics.controller";

@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
