import { Module } from "@nestjs/common";
import { OnboardingSeedService } from "./onboarding-seed.service";

@Module({
  providers: [OnboardingSeedService],
  exports: [OnboardingSeedService],
})
export class OnboardingSeedModule {}
