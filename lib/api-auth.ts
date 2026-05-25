import { auth } from "@/auth";
import { NextResponse } from "next/server";

export async function requireUserId(): Promise<string | NextResponse> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return userId;
}

export function isErrorResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse;
}
