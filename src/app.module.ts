import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { MailModule } from "./mail/mail.module";
import { RestaurantModule } from "./restaurant/restaurant.module";
import { CategoriesModule } from "./categories/categories.module";
import { ItemsModule } from "./items/items.module";
import { TablesModule } from "./tables/tables.module";
import { ReservationsModule } from "./reservations/reservations.module";
import { OrdersModule } from "./orders/orders.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MailModule,
    AuthModule,
    RestaurantModule,
    CategoriesModule,
    ItemsModule,
    TablesModule,
    ReservationsModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
