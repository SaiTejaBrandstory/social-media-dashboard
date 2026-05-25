import { NextRequest, NextResponse } from "next/server";
import { requireUserId, isErrorResponse } from "@/lib/api-auth";
import { assertBrandOwner } from "@/lib/brand-access";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ brandId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const userId = await requireUserId();
  if (isErrorResponse(userId)) return userId;

  const { brandId } = await params;
  if (!(await assertBrandOwner(brandId, userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const row = await prisma.trend.findUnique({ where: { brandId } });
  if (!row) return NextResponse.json(null);
  return NextResponse.json(row.payload);
}

export async function PUT(req: NextRequest, { params }: Params) {
  const userId = await requireUserId();
  if (isErrorResponse(userId)) return userId;

  const { brandId } = await params;
  if (!(await assertBrandOwner(brandId, userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const payload = {
    ...body,
    id: "latest",
    brandId,
    createdAt: body.createdAt || Date.now(),
  };

  await prisma.trend.upsert({
    where: { brandId },
    create: { brandId, userId, payload },
    update: { payload, userId },
  });

  return NextResponse.json(payload);
}
