import { NextResponse } from "next/server";
import { requireUserId, isErrorResponse } from "@/lib/api-auth";
import { assertBrandOwner } from "@/lib/brand-access";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ brandId: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  const userId = await requireUserId();
  if (isErrorResponse(userId)) return userId;

  const { brandId } = await params;
  const brand = await assertBrandOwner(brandId, userId);
  if (!brand) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.brand.delete({ where: { id: brandId } });
  return NextResponse.json({ ok: true });
}
