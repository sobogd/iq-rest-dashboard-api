-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('KITCHEN', 'WAITER');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DeviceType" NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pairing_codes" (
    "code" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pairing_codes_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "devices_companyId_idx" ON "devices"("companyId");

-- CreateIndex
CREATE INDEX "devices_restaurantId_idx" ON "devices"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "pairing_codes_deviceId_key" ON "pairing_codes"("deviceId");

-- CreateIndex
CREATE INDEX "pairing_codes_expiresAt_idx" ON "pairing_codes"("expiresAt");

-- AddForeignKey
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
