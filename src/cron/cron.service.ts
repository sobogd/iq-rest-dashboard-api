import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24h after signup
const MAX_PER_RUN = 200; // hard cap to prevent runaway deletions

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupEmptyCompanies() {
    const dryRun = process.env.CRON_CLEANUP_DRY_RUN === "true";
    const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);

    // Multiple safety filters — must satisfy ALL to qualify for deletion:
    //   1. Created more than 24h ago (grace period for fresh signups).
    //   2. Plan stayed FREE (paying customers always preserved).
    //   3. No active subscription (defensive double-check).
    //   4. No Stripe customer (never went through checkout).
    //   5. Zero categories.
    //   6. Zero items.
    //   7. Zero support messages.
    //   8. Zero analytics sessions referencing the company.
    //   9. Zero page views.
    const candidates = await this.prisma.company.findMany({
      where: {
        createdAt: { lt: cutoff },
        plan: "FREE",
        subscriptionStatus: { not: "ACTIVE" },
        stripeCustomerId: null,
        categories: { none: {} },
        items: { none: {} },
        supportMessages: { none: {} },
      },
      include: {
        users: { include: { user: { select: { id: true, email: true } } } },
        _count: { select: { pageViews: true } },
      },
      take: MAX_PER_RUN,
    });

    // Session has companyId but no inverse relation, count separately.
    const targets: typeof candidates = [];
    for (const c of candidates) {
      if (c._count.pageViews > 0) continue;
      const sessionCount = await this.prisma.session.count({ where: { companyId: c.id } });
      if (sessionCount > 0) continue;
      targets.push(c);
    }

    if (targets.length === 0) {
      this.logger.log(`[cleanup] no empty companies to delete`);
      return;
    }

    this.logger.warn(
      `[cleanup] ${dryRun ? "DRY-RUN" : "DELETING"} ${targets.length} empty companies` +
        (targets.length > 0 ? ` (first id=${targets[0].id})` : ""),
    );

    if (dryRun) {
      for (const c of targets) {
        this.logger.warn(
          `  would delete companyId=${c.id} name=${JSON.stringify(c.name)} createdAt=${c.createdAt.toISOString()} users=${c.users.length}`,
        );
      }
      return;
    }

    let deleted = 0;
    for (const company of targets) {
      try {
        await this.prisma.company.delete({ where: { id: company.id } });
        // Drop orphan users (users not linked to any other company).
        for (const uc of company.users) {
          const others = await this.prisma.userCompany.count({ where: { userId: uc.userId } });
          if (others === 0) {
            await this.prisma.user
              .delete({ where: { id: uc.userId } })
              .catch((e) => this.logger.warn(`  user delete failed ${uc.userId}: ${e}`));
          }
        }
        deleted++;
      } catch (e) {
        this.logger.error(`  failed to delete companyId=${company.id}: ${e}`);
      }
    }
    this.logger.warn(`[cleanup] deleted ${deleted}/${targets.length} companies`);
  }
}
