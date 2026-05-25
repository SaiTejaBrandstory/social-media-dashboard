import { NextRequest, NextResponse } from "next/server";
import { requireUserId, isErrorResponse } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const userId = await requireUserId();
  if (isErrorResponse(userId)) return userId;

  const { id } = await params;
  const brandId = req.nextUrl.searchParams.get("brandId");
  if (!brandId) {
    return NextResponse.json({ error: "brandId required" }, { status: 400 });
  }

  const brief = await prisma.brief.findFirst({
    where: { id, brandId, userId },
  });
  if (!brief) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.brief.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
