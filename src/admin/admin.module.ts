import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";

@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminGuard],
})
export class AdminModule {}
