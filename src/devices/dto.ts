import { IsEnum, IsOptional, IsString, Length, Matches } from "class-validator";

export class CreateDeviceDto {
  @IsString()
  @Length(1, 80)
  name!: string;

  @IsEnum(["KITCHEN", "WAITER"] as const)
  type!: "KITCHEN" | "WAITER";

  @IsOptional()
  @IsString()
  restaurantId?: string;
}

export class PairDeviceDto {
  @Matches(/^[0-9]{6}$/, { message: "Code must be 6 digits" })
  code!: string;
}
