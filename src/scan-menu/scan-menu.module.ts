import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ScanMenuController } from "./scan-menu.controller";

@Module({
  imports: [AuthModule],
  controllers: [ScanMenuController],
})
export class ScanMenuModule {}
