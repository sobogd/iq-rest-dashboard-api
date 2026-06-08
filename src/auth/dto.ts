import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CUISINE_KEYS } from "../onboarding/cuisine";

export class SignupContextDto {
  @IsOptional()
  @IsIn(CUISINE_KEYS as unknown as string[])
  cuisine?: string;

  @IsString()
  @MaxLength(120)
  restaurantName!: string;
}

export class SendOtpDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SignupContextDto)
  signupContext?: SignupContextDto;
}

export class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

export class DemoDto {
  @IsOptional()
  @IsString()
  locale?: string;
}

export class ClaimStartDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  locale?: string;
}

export class ClaimVerifyDto {
  @IsString()
  @Length(6, 6)
  code!: string;

  /** true → keep tables + menu (categories/items); false → start with an empty
   *  restaurant. Fake orders/reservations are removed either way. */
  @IsOptional()
  @IsBoolean()
  keepData?: boolean;
}

export class GoogleAuthDto {
  /** id_token JWT (legacy renderButton flow). */
  @IsOptional()
  @IsString()
  credential?: string;

  /** Authorization code from initCodeClient popup flow.
   *  Either credential or code must be provided. */
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SignupContextDto)
  signupContext?: SignupContextDto;
}

// Apple posts these fields (application/x-www-form-urlencoded) to the
// redirect URI. `user` is a JSON string sent only on the user's FIRST
// authorization; everything else is present every time.
export class AppleCallbackDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  id_token?: string;

  @IsOptional()
  @IsString()
  state?: string;

  /** JSON string: {"name":{"firstName":"…","lastName":"…"},"email":"…"} */
  @IsOptional()
  @IsString()
  user?: string;

  @IsOptional()
  @IsString()
  error?: string;
}
