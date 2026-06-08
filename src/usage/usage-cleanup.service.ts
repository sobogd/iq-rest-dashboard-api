import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

/** Hourly purge of usage_events older than 7 days. Keeps the internal
 *  analytics events table from growing unbounded. */
@Injectable()
export class UsageCleanupService {
  private readonly logger = new Logger(UsageCleanupService.name);
  private static readonly RETENTION_DAYS = 7;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purgeOldEvents(): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - UsageCleanupService.RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const { count } = await this.prisma.usageEvent.deleteMany({
        where: { at: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(`purged ${count} usage_events older than ${cutoff.toISOString()}`);
      }
    } catch (err) {
      this.logger.warn(`usage_events purge failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
