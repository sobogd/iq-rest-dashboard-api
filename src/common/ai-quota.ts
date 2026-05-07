import { ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export const FREE_AI_IMAGE_QUOTA = 5;

export function isPaidActive(company: { plan: string | null; subscriptionStatus: string | null }): boolean {
  return company.subscriptionStatus === "ACTIVE" && !!company.plan && company.plan !== "FREE";
}

// Atomically reserve a free-quota slot before doing the expensive Gemini call.
// Paid plans skip the reservation (no quota); free plans bump the counter
// inside a conditional updateMany so two concurrent requests can't both pass
// the limit check before either has incremented.
export async function consumeAiImageQuota(
  prisma: PrismaService,
  companyId: string,
): Promise<{ restaurantId: string; isPaid: boolean }> {
  const [company, restaurant] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { plan: true, subscriptionStatus: true },
    }),
    prisma.restaurant.findFirst({
      where: { companyId },
      select: { id: true },
    }),
  ]);
  if (!company || !restaurant) throw new ForbiddenException("Not found");

  const paid = isPaidActive(company);
  if (paid) return { restaurantId: restaurant.id, isPaid: true };

  const reserved = await prisma.restaurant.updateMany({
    where: { id: restaurant.id, imageGenerationsUsed: { lt: FREE_AI_IMAGE_QUOTA } },
    data: { imageGenerationsUsed: { increment: 1 } },
  });
  if (reserved.count === 0) {
    throw new ForbiddenException("ai_quota_exceeded");
  }
  return { restaurantId: restaurant.id, isPaid: false };
}

// Counter already incremented atomically in consumeAiImageQuota. Kept as a
// no-op to preserve call sites; if the downstream operation fails callers
// should call refundAiImageUsage instead.
export async function incrementAiImageUsage(_prisma: PrismaService, _restaurantId: string) {
  // intentionally empty
}

export async function refundAiImageUsage(prisma: PrismaService, restaurantId: string) {
  await prisma.restaurant.updateMany({
    where: { id: restaurantId, imageGenerationsUsed: { gt: 0 } },
    data: { imageGenerationsUsed: { decrement: 1 } },
  });
}

// Translation quota was removed — translations are unlimited and free.
// Manual /api/translate and the auto-translate background worker both run
// without metering.

export async function getAiImageUsage(prisma: PrismaService, companyId: string) {
  const [company, restaurant] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { plan: true, subscriptionStatus: true },
    }),
    prisma.restaurant.findFirst({
      where: { companyId },
      select: { imageGenerationsUsed: true },
    }),
  ]);
  const paid = company ? isPaidActive(company) : false;
  return {
    aiImagesUsed: restaurant?.imageGenerationsUsed ?? 0,
    aiImagesLimit: paid ? null : FREE_AI_IMAGE_QUOTA,
  };
}
