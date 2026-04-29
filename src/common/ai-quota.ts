import { ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export const FREE_AI_IMAGE_QUOTA = 5;

export function isPaidActive(company: { plan: string | null; subscriptionStatus: string | null }): boolean {
  return company.subscriptionStatus === "ACTIVE" && !!company.plan && company.plan !== "FREE";
}

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
      select: { id: true, imageGenerationsUsed: true },
    }),
  ]);
  if (!company || !restaurant) throw new ForbiddenException("Not found");

  const paid = isPaidActive(company);
  if (!paid && restaurant.imageGenerationsUsed >= FREE_AI_IMAGE_QUOTA) {
    throw new ForbiddenException("ai_quota_exceeded");
  }
  return { restaurantId: restaurant.id, isPaid: paid };
}

export async function incrementAiImageUsage(prisma: PrismaService, restaurantId: string) {
  await prisma.restaurant.update({
    where: { id: restaurantId },
    data: { imageGenerationsUsed: { increment: 1 } },
  });
}

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
