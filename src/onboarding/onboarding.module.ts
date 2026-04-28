import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OnboardingController } from "./onboarding.controller";

@Module({
  imports: [AuthModule],
  controllers: [OnboardingController],
})
export class OnboardingModule {}
