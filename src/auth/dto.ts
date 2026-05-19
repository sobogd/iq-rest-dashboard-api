import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { CUISINE_KEYS } from "../onboarding/cuisine";

export class SignupContextDto {
  @IsIn(CUISINE_KEYS as unknown as string[])
  cuisine!: string;

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
