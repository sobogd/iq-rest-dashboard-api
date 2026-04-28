import { IsEmail, IsOptional, IsString, Length } from "class-validator";

export class SendOtpDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  locale?: string;
}

export class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
