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
  const name = String(body?.name ?? "").trim();
  const targetCustomerProfile = String(
    body?.target_customer_profile ?? "",
  ).trim();
  const growthObjective = String(body?.growth_objective ?? "").trim();
  const brandTone = String(body?.brand_tone ?? body?.brand_tone_personality ?? "").trim();
  const brandPersonality = String(body?.brand_personality ?? "").trim();
  const brandLanguage = String(body?.brand_language ?? "").trim();

  if (!name) {
    return NextResponse.json({ error: "Brand name is required" }, { status: 400 });
  }
  if (!targetCustomerProfile) {
    return NextResponse.json(
      { error: "Target customer profile is required" },
      { status: 400 },
    );
  }
  if (!growthObjective) {
    return NextResponse.json(
      { error: "Growth objective is required" },
      { status: 400 },
    );
  }
  if (!brandTone) {
    return NextResponse.json({ error: "Brand tone is required" }, { status: 400 });
  }
  if (!brandPersonality) {
    return NextResponse.json(
      { error: "Brand personality is required" },
      { status: 400 },
    );
  }
  if (!brandLanguage) {
    return NextResponse.json(
      { error: "Brand language is required" },
      { status: 400 },
    );
  }

  const id =
    body.id || `b_${Math.random().toString(36).slice(2, 10)}`;
  const payload = {
    ...body,
    name,
    target_customer_profile: targetCustomerProfile,
    growth_objective: growthObjective,
    brand_tone: brandTone,
    brand_personality: brandPersonality,
    brand_language: brandLanguage,
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
