import { Type } from "class-transformer";
import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

// `options` is validated by a zod schema inside ItemsService (variant groups
// are too rich for class-validator). @Allow() keeps the property through the
// whitelist without class-validator touching it. @IsNumber rejects NaN/Infinity
// and @Min(0) blocks the negative prices the UI used to forbid client-side only.
export class CreateItemDto {
  @IsString()
  @MaxLength(300)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsString()
  imageUrl?: string | null;

  @IsString()
  categoryId!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  translations?: Record<string, { name?: string; description?: string }> | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  diets?: string[];

  @IsOptional()
  @Allow()
  options?: unknown;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  imageUrl?: string | null;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  translations?: Record<string, { name?: string; description?: string }> | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  diets?: string[];

  @IsOptional()
  @Allow()
  options?: unknown;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class PatchItemDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ReorderItemDto {
  @IsString()
  itemId!: string;

  @IsIn(["up", "down"])
  direction!: "up" | "down";
}

export class ReorderBulkEntryDto {
  @IsString()
  id!: string;

  @IsInt()
  sortOrder!: number;
}

export class ReorderBulkDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderBulkEntryDto)
  items!: ReorderBulkEntryDto[];
}
