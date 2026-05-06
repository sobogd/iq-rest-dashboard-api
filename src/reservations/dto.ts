import { IsIn, IsString } from "class-validator";

export const RESERVATION_STATUSES = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export class SetStatusDto {
  @IsString()
  @IsIn(RESERVATION_STATUSES as unknown as string[])
  status!: ReservationStatus;
}
