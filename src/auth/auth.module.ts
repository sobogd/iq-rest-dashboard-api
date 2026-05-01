import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthGuard } from "./auth.guard";
import { MailModule } from "../mail/mail.module";
import { OnboardingSeedModule } from "../onboarding/onboarding-seed.module";

@Module({
  imports: [MailModule, OnboardingSeedModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
