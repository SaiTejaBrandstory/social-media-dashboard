import { prisma } from "@/lib/prisma";

export async function assertBrandOwner(brandId: string, userId: string) {
  const brand = await prisma.brand.findFirst({
    where: { id: brandId, userId },
  });
  return brand;
}
