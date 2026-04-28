import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type RestaurantPatch = Partial<Omit<Prisma.RestaurantUpdateInput, "company" | "tables" | "reservations" | "orders">>;

@Injectable()
export class RestaurantService {
  constructor(private readonly prisma: PrismaService) {}

  async getByCompany(companyId: string) {
    return this.prisma.restaurant.findFirst({ where: { companyId } });
  }

  async upsert(companyId: string, data: Record<string, unknown>) {
    const existing = await this.prisma.restaurant.findFirst({ where: { companyId } });

    const allowed: RestaurantPatch = {
      title: data.title as string | undefined,
      subtitle: (data.subtitle as string | null | undefined),
      description: data.description as string | null | undefined,
      slug: data.slug as string | null | undefined,
      currency: data.currency as string | undefined,
      source: data.source as string | null | undefined,
      backgroundType: data.backgroundType as string | null | undefined,
      accentColor: data.accentColor as string | undefined,
      address: data.address as string | null | undefined,
      x: data.x as string | null | undefined,
      y: data.y as string | null | undefined,
      phone: data.phone as string | null | undefined,
      instagram: data.instagram as string | null | undefined,
      whatsapp: data.whatsapp as string | null | undefined,
      languages: data.languages as string[] | undefined,
      defaultLanguage: data.defaultLanguage as string | undefined,
      hideTitle: data.hideTitle as boolean | undefined,
      reservationsEnabled: data.reservationsEnabled as boolean | undefined,
      reservationMode: data.reservationMode as string | undefined,
      reservationSlotMinutes: data.reservationSlotMinutes as number | undefined,
      workingHoursStart: data.workingHoursStart as string | undefined,
      workingHoursEnd: data.workingHoursEnd as string | undefined,
      ordersEnabled: data.ordersEnabled as boolean | undefined,
      orderNameEnabled: data.orderNameEnabled as boolean | undefined,
      orderPhoneEnabled: data.orderPhoneEnabled as boolean | undefined,
      orderAddressEnabled: data.orderAddressEnabled as boolean | undefined,
      orderMode: data.orderMode as string | undefined,
    };

    // Drop undefined keys.
    const patch: Prisma.RestaurantUpdateInput = {};
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    }

    if (existing) {
      return this.prisma.restaurant.update({ where: { id: existing.id }, data: patch });
    }

    return this.prisma.restaurant.create({
      data: {
        title: (allowed.title as string) || "",
        currency: (allowed.currency as string) || "EUR",
        accentColor: (allowed.accentColor as string) || "#000000",
        languages: (allowed.languages as string[]) || ["en"],
        defaultLanguage: (allowed.defaultLanguage as string) || "en",
        ...patch,
        company: { connect: { id: companyId } },
        startedFromScratch: true,
      },
    });
  }
}
