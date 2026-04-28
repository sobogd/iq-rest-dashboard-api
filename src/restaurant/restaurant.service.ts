import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

interface RestaurantInput {
  title?: string;
  subtitle?: string | null;
  description?: string | null;
  slug?: string | null;
  currency?: string;
  source?: string | null;
  backgroundType?: string | null;
  accentColor?: string;
  address?: string | null;
  x?: string | null;
  y?: string | null;
  phone?: string | null;
  instagram?: string | null;
  whatsapp?: string | null;
  languages?: string[];
  defaultLanguage?: string;
  hideTitle?: boolean;
  reservationsEnabled?: boolean;
  reservationMode?: string;
  reservationSlotMinutes?: number;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  ordersEnabled?: boolean;
  orderNameEnabled?: boolean;
  orderPhoneEnabled?: boolean;
  orderAddressEnabled?: boolean;
  orderMode?: string;
}

const FIELDS: (keyof RestaurantInput)[] = [
  "title", "subtitle", "description", "slug", "currency", "source", "backgroundType",
  "accentColor", "address", "x", "y", "phone", "instagram", "whatsapp", "languages",
  "defaultLanguage", "hideTitle", "reservationsEnabled", "reservationMode",
  "reservationSlotMinutes", "workingHoursStart", "workingHoursEnd", "ordersEnabled",
  "orderNameEnabled", "orderPhoneEnabled", "orderAddressEnabled", "orderMode",
];

function pickFields(raw: Record<string, unknown>): RestaurantInput {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (raw[f] !== undefined) out[f] = raw[f];
  return out as RestaurantInput;
}

@Injectable()
export class RestaurantService {
  constructor(private readonly prisma: PrismaService) {}

  async getByCompany(companyId: string) {
    return this.prisma.restaurant.findFirst({ where: { companyId } });
  }

  async upsert(companyId: string, raw: Record<string, unknown>) {
    const input = pickFields(raw);
    const existing = await this.prisma.restaurant.findFirst({ where: { companyId } });

    if (existing) {
      return this.prisma.restaurant.update({
        where: { id: existing.id },
        data: input as Prisma.RestaurantUpdateInput,
      });
    }

    const createData: Prisma.RestaurantUncheckedCreateInput = {
      companyId,
      title: input.title || "",
      currency: input.currency || "EUR",
      accentColor: input.accentColor || "#000000",
      languages: input.languages || ["en"],
      defaultLanguage: input.defaultLanguage || "en",
      startedFromScratch: true,
      ...input,
    };
    return this.prisma.restaurant.create({ data: createData });
  }
}
