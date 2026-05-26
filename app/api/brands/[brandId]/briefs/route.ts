import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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

  const rows = await prisma.brief.findMany({
    where: { brandId, userId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    rows.map((r) => r.payload as Record<string, unknown>),
  );
}

export async function POST(req: NextRequest, { params }: Params) {
  const userId = await requireUserId();
  if (isErrorResponse(userId)) return userId;

  const { brandId } = await params;
  if (!(await assertBrandOwner(brandId, userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const id =
    body.id ||
    `br_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const payload = {
    ...body,
    id,
    brandId,
    createdAt: body.createdAt || Date.now(),
    savedAt: body.savedAt || Date.now(),
    isActive: true,
  } as Prisma.InputJsonValue;

  const existing = await prisma.brief.findUnique({ where: { id } });
  if (existing && existing.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const contentId =
    typeof body.content_id === "string" ? body.content_id : "";
  if (contentId) {
    const siblings = await prisma.brief.findMany({
      where: { brandId, userId },
    });
    for (const row of siblings) {
      if (row.id === id) continue;
      const sibling = row.payload as Record<string, unknown>;
      if (sibling.content_id !== contentId) continue;
      if (sibling.isActive === true) {
        await prisma.brief.update({
          where: { id: row.id },
          data: {
            payload: { ...sibling, isActive: false } as Prisma.InputJsonValue,
          },
        });
      }
    }
  }

  await prisma.brief.upsert({
    where: { id },
    create: { id, brandId, userId, payload },
    update: { payload },
  });

  return NextResponse.json(payload);
}
