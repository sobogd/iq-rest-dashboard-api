import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UploadController } from "./upload.controller";

@Module({
  imports: [AuthModule],
  controllers: [UploadController],
})
export class UploadModule {}
