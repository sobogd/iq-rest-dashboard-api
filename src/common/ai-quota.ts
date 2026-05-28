import { ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export const FREE_AI_IMAGE_QUOTA = 5;

export function isPaidActive(r: { plan: string | null; subscriptionStatus: string | null }): boolean {
  return r.subscriptionStatus === "ACTIVE" && !!r.plan && r.plan !== "FREE";
}

// Atomically reserve a free-quota slot before doing the expensive Gemini call.
// Paid plans skip the reservation (no quota); free plans bump the counter
// inside a conditional updateMany so two concurrent requests can't both pass
// the limit check before either has incremented.
export async function consumeAiImageQuota(
  prisma: PrismaService,
  restaurantId: string,
): Promise<{ isPaid: boolean }> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { plan: true, subscriptionStatus: true },
  });
  if (!restaurant) throw new ForbiddenException("Not found");
  if (isPaidActive(restaurant)) return { isPaid: true };

  const reserved = await prisma.restaurant.updateMany({
    where: { id: restaurantId, imageGenerationsUsed: { lt: FREE_AI_IMAGE_QUOTA } },
    data: { imageGenerationsUsed: { increment: 1 } },
  });
  if (reserved.count === 0) {
    throw new ForbiddenException("ai_quota_exceeded");
  }
  return { isPaid: false };
}

export async function incrementAiImageUsage(_prisma: PrismaService, _restaurantId: string) {
  // intentionally empty — already incremented in consumeAiImageQuota
}

export async function refundAiImageUsage(prisma: PrismaService, restaurantId: string) {
  await prisma.restaurant.updateMany({
    where: { id: restaurantId, imageGenerationsUsed: { gt: 0 } },
    data: { imageGenerationsUsed: { decrement: 1 } },
  });
}

export async function getAiImageUsage(prisma: PrismaService, restaurantId: string) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { imageGenerationsUsed: true, plan: true, subscriptionStatus: true },
  });
  const paid = restaurant ? isPaidActive(restaurant) : false;
  return {
    aiImagesUsed: restaurant?.imageGenerationsUsed ?? 0,
    aiImagesLimit: paid ? null : FREE_AI_IMAGE_QUOTA,
  };
}
