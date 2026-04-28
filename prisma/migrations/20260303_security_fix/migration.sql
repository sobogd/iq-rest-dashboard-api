-- Add session token and OTP attempt counter to users
ALTER TABLE "users" ADD COLUMN "sessionToken" TEXT;
ALTER TABLE "users" ADD COLUMN "otpAttempts" INTEGER NOT NULL DEFAULT 0;
