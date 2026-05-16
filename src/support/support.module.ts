import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MailModule } from "../mail/mail.module";
import { SupportController } from "./support.controller";

@Module({
  imports: [AuthModule, MailModule],
  controllers: [SupportController],
})
export class SupportModule {}
