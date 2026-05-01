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
  @IsOptional()
  @IsString()
  credential?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SignupContextDto)
  signupContext?: SignupContextDto;
}
