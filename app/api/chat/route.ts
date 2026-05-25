import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Missing OPENROUTER_API_KEY. Add it to .env.local (local) or your hosting env (production).",
      },
      { status: 500 },
    );
  }

  try {
    const body = await req.json();
    const { model, messages, max_tokens, temperature } = body ?? {};

    const upstream = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": req.headers.get("referer") ?? "",
          "X-Title": "BrandStory Strategy OS",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens,
          temperature,
        }),
      },
    );

    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
