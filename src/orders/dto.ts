import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

// Order status enum — mirrors Order.status in schema.prisma. Without this the
// PATCH body was untyped, so any string could be written as a status (it then
// silently broke the board's status filters + analytics rollups).
export const ORDER_STATUSES = ["new", "in_progress", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Discount sub-object. The service recomputes totals from this server-side, so
// it must be well-formed. `reason` is free text shown back in the UI.
export class DiscountDto {
  @IsIn(["percent", "fixed"])
  type!: "percent" | "fixed";

  @IsNumber()
  value!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// `items` stays an opaque array on purpose: the service treats item bodies as
// snapshot JSON (it recomputes prices itself), and class-validator does not
// recurse into a bare @IsArray, so the inner objects pass through untouched.
export class CreateOrderDto {
  @IsOptional()
  @IsArray()
  items?: unknown[];

  @IsOptional()
  @IsNumber()
  total?: number;

  @IsOptional()
  @ValidateIf((o: CreateOrderDto) => o.tableNumber !== null)
  @IsInt()
  tableNumber?: number | null;

  @IsOptional()
  @ValidateIf((o: CreateOrderDto) => o.customerName !== null)
  @IsString()
  @MaxLength(200)
  customerName?: string | null;
}

export class PatchOrderDto {
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @IsArray()
  items?: unknown[];

  @IsOptional()
  @IsNumber()
  total?: number;

  @IsOptional()
  @ValidateIf((o: PatchOrderDto) => o.tableNumber !== null)
  @IsInt()
  tableNumber?: number | null;

  @IsOptional()
  @ValidateIf((o: PatchOrderDto) => o.paymentMethodId !== null)
  @IsString()
  paymentMethodId?: string | null;

  // `null` clears the discount — allowed and meaningful, so skip nested
  // validation in that case.
  @IsOptional()
  @ValidateIf((o: PatchOrderDto) => o.discount !== null)
  @ValidateNested()
  @Type(() => DiscountDto)
  discount?: DiscountDto | null;
}

export class SplitOrderDto {
  @IsArray()
  @IsString({ each: true })
  itemIds!: string[];

  // Client-advisory only — the service recomputes both totals from the item
  // split. Kept for wire-compat; safe to drop later.
  @IsOptional()
  @IsNumber()
  sourceTotal?: number;

  @IsOptional()
  @IsNumber()
  createdTotal?: number;
}
