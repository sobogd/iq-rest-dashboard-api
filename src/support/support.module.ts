import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SupportController } from "./support.controller";

@Module({
  imports: [AuthModule],
  controllers: [SupportController],
})
export class SupportModule {}
