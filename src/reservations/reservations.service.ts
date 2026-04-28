import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  private async restaurantId(companyId: string) {
    const r = await this.prisma.restaurant.findFirst({ where: { companyId }, select: { id: true } });
    return r?.id;
  }

  async list(companyId: string) {
    const rid = await this.restaurantId(companyId);
    if (!rid) return [];
    return this.prisma.reservation.findMany({
      where: { restaurantId: rid },
      orderBy: [{ date: "desc" }, { startTime: "desc" }],
    });
  }

  async setStatus(companyId: string, id: string, status: string) {
    const rid = await this.restaurantId(companyId);
    if (!rid) throw new NotFoundException();
    const res = await this.prisma.reservation.findFirst({ where: { id, restaurantId: rid } });
    if (!res) throw new NotFoundException();
    return this.prisma.reservation.update({ where: { id }, data: { status } });
  }

  async remove(companyId: string, id: string) {
    const rid = await this.restaurantId(companyId);
    if (!rid) throw new NotFoundException();
    const res = await this.prisma.reservation.findFirst({ where: { id, restaurantId: rid } });
    if (!res) throw new NotFoundException();
    await this.prisma.reservation.delete({ where: { id } });
  }
}
