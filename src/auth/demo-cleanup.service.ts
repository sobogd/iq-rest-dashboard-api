import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

/** Hourly purge of ephemeral demo accounts older than the retention window.
 *  Claimed demos have `isDemo` flipped to false and are skipped. Deleting the
 *  owned restaurant cascades all menu/order/device data (every child relation
 *  is `onDelete: Cascade`); deleting the user then cascades sessions. */
@Injectable()
export class DemoCleanupService {
  private readonly logger = new Logger(DemoCleanupService.name);
  private static readonly RETENTION_HOURS = 24;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purgeOldDemos(): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - DemoCleanupService.RETENTION_HOURS * 60 * 60 * 1000,
      );
      const demos = await this.prisma.user.findMany({
        where: { isDemo: true, demoCreatedAt: { lt: cutoff } },
        select: { id: true },
      });
      if (demos.length === 0) return;

      let deleted = 0;
      for (const demo of demos) {
        // Drop restaurants this demo owns (addedBy === null) — cascades the
        // whole menu/orders/devices subtree.
        const owned = await this.prisma.restaurantUser.findMany({
          where: { userId: demo.id, addedBy: null },
          select: { restaurantId: true },
        });
        if (owned.length > 0) {
          await this.prisma.restaurant.deleteMany({
            where: { id: { in: owned.map((o) => o.restaurantId) } },
          });
        }
        await this.prisma.user.delete({ where: { id: demo.id } }).catch(() => undefined);
        deleted++;
      }
      this.logger.log(`purged ${deleted} demo account(s) older than ${cutoff.toISOString()}`);
    } catch (err) {
      this.logger.warn(`demo purge failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
