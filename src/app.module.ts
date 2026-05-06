import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { I18nModule } from "./i18n/i18n.module";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { MailModule } from "./mail/mail.module";
import { RestaurantModule } from "./restaurant/restaurant.module";
import { CategoriesModule } from "./categories/categories.module";
import { ItemsModule } from "./items/items.module";
import { TablesModule } from "./tables/tables.module";
import { ReservationsModule } from "./reservations/reservations.module";
import { OrdersModule } from "./orders/orders.module";
import { UploadModule } from "./upload/upload.module";
import { TranslateModule } from "./translate/translate.module";
import { SupportModule } from "./support/support.module";
import { StripeModule } from "./stripe/stripe.module";
import { GeoModule } from "./geo/geo.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { UsageModule } from "./usage/usage.module";
import { AdminModule } from "./admin/admin.module";
import { ScanMenuModule } from "./scan-menu/scan-menu.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      // Default global limit. Per-route overrides via @Throttle.
      { name: "default", ttl: 60_000, limit: 600 },
    ]),
    I18nModule,
    PrismaModule,
    MailModule,
    AuthModule,
    RestaurantModule,
    CategoriesModule,
    ItemsModule,
    TablesModule,
    ReservationsModule,
    OrdersModule,
    UploadModule,
    TranslateModule,
    SupportModule,
    StripeModule,
    GeoModule,
    AnalyticsModule,
    UsageModule,
    AdminModule,
    ScanMenuModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
