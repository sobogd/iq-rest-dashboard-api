import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MailModule } from "../mail/mail.module";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";

@Module({
  imports: [AuthModule, MailModule],
  controllers: [AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}
