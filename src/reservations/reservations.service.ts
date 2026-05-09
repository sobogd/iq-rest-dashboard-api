import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import type { ReservationStatus } from "./dto";

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService) {}

  private async restaurantIds(companyId: string) {
    const rs = await this.prisma.restaurant.findMany({
      where: { companyId },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    return rs.map((r) => r.id);
  }

  async list(companyId: string) {
    const ids = await this.restaurantIds(companyId);
    if (ids.length === 0) return [];
    return this.prisma.reservation.findMany({
      where: { restaurantId: { in: ids } },
      orderBy: [{ date: "desc" }, { startTime: "desc" }],
    });
  }

  async setStatus(companyId: string, id: string, status: ReservationStatus) {
    const ids = await this.restaurantIds(companyId);
    if (ids.length === 0) throw new NotFoundException();
    const res = await this.prisma.reservation.findFirst({
      where: { id, restaurantId: { in: ids } },
      include: { restaurant: { select: { title: true, defaultLanguage: true } }, table: { select: { number: true } } },
    });
    if (!res) throw new NotFoundException();
    const updated = await this.prisma.reservation.update({ where: { id }, data: { status } });

    // Notify guest on confirm/cancel transitions only — not on completed/pending
    // updates. Skip if status didn't actually change.
    if ((status === "confirmed" || status === "cancelled") && res.status !== status && res.guestEmail) {
      const dateStr =
        res.date instanceof Date
          ? `${res.date.getUTCFullYear()}-${String(res.date.getUTCMonth() + 1).padStart(2, "0")}-${String(res.date.getUTCDate()).padStart(2, "0")}`
          : String(res.date);
      this.mail
        .sendReservationStatus({
          email: res.guestEmail,
          guestName: res.guestName,
          restaurantTitle: res.restaurant.title,
          date: dateStr,
          startTime: res.startTime,
          guestsCount: res.guestsCount,
          tableNumber: res.table?.number ?? null,
          status,
          locale: res.restaurant.defaultLanguage || "en",
        })
        .catch((err) => this.logger.warn(`reservation status email failed: ${err?.message || err}`));
    }

    return updated;
  }

  async remove(companyId: string, id: string) {
    const ids = await this.restaurantIds(companyId);
    if (ids.length === 0) throw new NotFoundException();
    const res = await this.prisma.reservation.findFirst({
      where: { id, restaurantId: { in: ids } },
    });
    if (!res) throw new NotFoundException();
    await this.prisma.reservation.delete({ where: { id } });
  }
}
