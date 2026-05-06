import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { ReservationStatus } from "./dto";

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

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
    });
    if (!res) throw new NotFoundException();
    return this.prisma.reservation.update({ where: { id }, data: { status } });
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
