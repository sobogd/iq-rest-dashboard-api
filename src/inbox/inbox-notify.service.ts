import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";

/** Half-hourly digest: if any inbox thread (WhatsApp non-muted contacts or
 *  internal support threads) has inbound messages newer than its read marker,
 *  email the support inbox once. Opening a thread marks it read, so a reminder
 *  keeps arriving every 30 min until the admin reads everything. */
@Injectable()
export class InboxNotifyService {
  private readonly logger = new Logger(InboxNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async notifyUnread(): Promise<void> {
    try {
      const count = await this.countUnreadThreads();
      if (count > 0) {
        await this.mail.sendAdminUnreadInboxNotification(count);
      }
    } catch (err) {
      this.logger.warn(`unread digest failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /** Number of threads with at least one unread inbound message. */
  private async countUnreadThreads(): Promise<number> {
    const reads = await this.prisma.inboxRead.findMany();
    const readMap = new Map(reads.map((r) => [r.threadId, r.readAt]));

    // WhatsApp: last inbound per non-muted contact.
    const waRows = await this.prisma.$queryRaw<{ id: string; last_in: Date }[]>(Prisma.sql`
      SELECT m."contactId" AS id, max(m."createdAt") AS last_in
      FROM inbox_messages m
      JOIN inbox_contacts c ON c.id = m."contactId"
      WHERE m.direction = 'in' AND c.muted = false
      GROUP BY m."contactId"
    `);
    let count = 0;
    for (const r of waRows) {
      const readAt = readMap.get(`wa:${r.id}`);
      if (!readAt || r.last_in > readAt) count++;
    }

    // Internal: last customer message per restaurant.
    const intRows = await this.prisma.$queryRaw<{ id: string; last_in: Date }[]>(Prisma.sql`
      SELECT sm."restaurantId" AS id, max(sm."createdAt") AS last_in
      FROM support_messages sm
      WHERE sm."isAdmin" = false
      GROUP BY sm."restaurantId"
    `);
    for (const r of intRows) {
      const readAt = readMap.get(`int:${r.id}`);
      if (!readAt || r.last_in > readAt) count++;
    }

    return count;
  }
}
