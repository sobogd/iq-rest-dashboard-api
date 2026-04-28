import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TablesController } from "./tables.controller";
import { TablesService } from "./tables.service";

@Module({
  imports: [AuthModule],
  controllers: [TablesController],
  providers: [TablesService],
})
export class TablesModule {}
