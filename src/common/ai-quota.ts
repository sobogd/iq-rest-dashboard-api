import { ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export const FREE_AI_IMAGE_QUOTA = 5;

/** A restaurant counts as "paid" — i.e. unlocked for AI image generation
 *  and other paid features — when EITHER:
 *    - it has an ACTIVE non-FREE subscription, OR
 *    - it is inside its 14-day trial window (`trialEndsAt > now`).
 *
 *  Mirrors `DevicesService.assertRestaurantMayUseDevices` so both paid-only
 *  gates treat trial users consistently. */
export function isPaidActive(r: {
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt?: Date | null;
}): boolean {
  const subActive = r.subscriptionStatus === "ACTIVE" && !!r.plan && r.plan !== "FREE";
  if (subActive) return true;
  const inTrial = !!r.trialEndsAt && r.trialEndsAt > new Date();
  return inTrial;
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
    select: { plan: true, subscriptionStatus: true, trialEndsAt: true },
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
    select: {
      imageGenerationsUsed: true,
      plan: true,
      subscriptionStatus: true,
      trialEndsAt: true,
    },
  });
  const paid = restaurant ? isPaidActive(restaurant) : false;
  return {
    aiImagesUsed: restaurant?.imageGenerationsUsed ?? 0,
    aiImagesLimit: paid ? null : FREE_AI_IMAGE_QUOTA,
  };
}
