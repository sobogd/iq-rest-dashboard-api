import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const reservationDaySchema = z
  .object({
    closed: z.boolean(),
    from: z.string().regex(HHMM),
    to: z.string().regex(HHMM),
    lunchFrom: z.string().regex(HHMM).nullable(),
    lunchTo: z.string().regex(HHMM).nullable(),
  })
  .refine((d) => d.closed || d.from < d.to, { message: "from must be < to" })
  .refine(
    (d) => (d.lunchFrom === null) === (d.lunchTo === null),
    { message: "lunchFrom and lunchTo must both be set or both null" }
  )
  .refine(
    (d) => d.lunchFrom === null || d.lunchTo === null || d.lunchFrom < d.lunchTo,
    { message: "lunchFrom must be < lunchTo" }
  )
  .refine(
    (d) =>
      d.closed ||
      d.lunchFrom === null ||
      d.lunchTo === null ||
      (d.lunchFrom >= d.from && d.lunchTo <= d.to),
    { message: "lunch break must be inside working hours" }
  );

const reservationScheduleSchema = z.array(reservationDaySchema).length(7);

type ReservationSchedule = z.infer<typeof reservationScheduleSchema>;

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
  reservationSchedule?: ReservationSchedule | null;
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
  "reservationSlotMinutes", "workingHoursStart", "workingHoursEnd",
  "reservationSchedule", "ordersEnabled",
  "orderNameEnabled", "orderPhoneEnabled", "orderAddressEnabled", "orderMode",
];

function pickFields(raw: Record<string, unknown>): RestaurantInput {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (raw[f] !== undefined) out[f] = raw[f];
  if (out.reservationSchedule !== undefined && out.reservationSchedule !== null) {
    const parsed = reservationScheduleSchema.safeParse(out.reservationSchedule);
    if (!parsed.success) {
      throw new BadRequestException(
        "Invalid reservationSchedule: " + parsed.error.issues[0]?.message
      );
    }
    out.reservationSchedule = parsed.data;
  }
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

    // Translate `null` on JSON column to Prisma's DbNull sentinel — plain
    // null from the JS side trips the unchecked create/update typings.
    const { reservationSchedule, ...rest } = input;
    const scheduleField =
      reservationSchedule === undefined
        ? {}
        : reservationSchedule === null
          ? { reservationSchedule: Prisma.DbNull }
          : { reservationSchedule: reservationSchedule as Prisma.InputJsonValue };

    if (existing) {
      return this.prisma.restaurant.update({
        where: { id: existing.id },
        data: { ...(rest as Prisma.RestaurantUpdateInput), ...scheduleField },
      });
    }

    const slug = rest.slug || (await this.uniqueSlug(rest.title || "rest"));
    const createData: Prisma.RestaurantUncheckedCreateInput = {
      companyId,
      title: rest.title || "",
      slug,
      currency: rest.currency || "EUR",
      accentColor: rest.accentColor || "#000000",
      languages: rest.languages || ["en"],
      defaultLanguage: rest.defaultLanguage || "en",
      startedFromScratch: true,
      ...rest,
      ...scheduleField,
    };
    return this.prisma.restaurant.create({ data: createData });
  }

  private async uniqueSlug(seed: string): Promise<string> {
    const base = (seed || "rest")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "rest";
    let slug = base;
    let i = 0;
    while (await this.prisma.restaurant.findFirst({ where: { slug }, select: { id: true } })) {
      i++;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      if (i > 10) {
        slug = base + "-" + Date.now().toString(36);
        break;
      }
    }
    return slug;
  }
}
