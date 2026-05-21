import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import type { ReservationStatus } from "./dto";

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService) {}

  async list(restaurantId: string) {
    return this.prisma.reservation.findMany({
      where: { restaurantId },
      orderBy: [{ date: "desc" }, { startTime: "desc" }],
    });
  }

  async setStatus(restaurantId: string, id: string, status: ReservationStatus) {
    const res = await this.prisma.reservation.findFirst({
      where: { id, restaurantId },
      include: { restaurant: { select: { title: true, defaultLanguage: true } }, table: { select: { number: true } } },
    });
    if (!res) throw new NotFoundException();
    const updated = await this.prisma.reservation.update({ where: { id }, data: { status } });

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

  async remove(restaurantId: string, id: string) {
    const res = await this.prisma.reservation.findFirst({
      where: { id, restaurantId },
    });
    if (!res) throw new NotFoundException();
    await this.prisma.reservation.delete({ where: { id } });
  }
}
