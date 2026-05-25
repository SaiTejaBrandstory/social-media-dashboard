import { NextRequest, NextResponse } from "next/server";
import { requireUserId, isErrorResponse } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const userId = await requireUserId();
  if (isErrorResponse(userId)) return userId;

  const rows = await prisma.brand.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(
    rows.map((r) => r.payload as Record<string, unknown>),
  );
}

export async function POST(req: NextRequest) {
  const userId = await requireUserId();
  if (isErrorResponse(userId)) return userId;

  const body = await req.json();
  if (!body?.name) {
    return NextResponse.json({ error: "Brand name is required" }, { status: 400 });
  }

  const id =
    body.id || `b_${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    ...body,
    id,
    updatedAt: Date.now(),
  };

  const existing = await prisma.brand.findUnique({ where: { id } });
  if (existing && existing.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.brand.upsert({
    where: { id },
    create: { id, userId, payload },
    update: { payload },
  });

  return NextResponse.json(payload);
}
