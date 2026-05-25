import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";

// @IsOptional() treats null/undefined as "skip" so nullable fields
// (translations, parentId) pass through untouched for the service to handle.
// translations is kept as an opaque object — class-validator doesn't recurse
// without a nested DTO, so the per-locale map survives whitelist stripping.
export class CreateCategoryDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsObject()
  translations?: Record<string, { name: string }> | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;

  @IsOptional()
  @IsString()
  parentId?: string | null;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsObject()
  translations?: Record<string, { name: string }> | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isGroup?: boolean;

  @IsOptional()
  @IsString()
  parentId?: string | null;
}

export class ReorderEntryDto {
  @IsString()
  id!: string;

  @IsInt()
  sortOrder!: number;
}

export class ReorderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderEntryDto)
  items!: ReorderEntryDto[];
}
