import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminGuard } from "../admin/admin.guard";
import { InboxController } from "./inbox.controller";
import { WhatsappController } from "./whatsapp.controller";
import { WhatsappService } from "./whatsapp.service";

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [InboxController, WhatsappController],
  providers: [AdminGuard, WhatsappService],
})
export class InboxModule {}
