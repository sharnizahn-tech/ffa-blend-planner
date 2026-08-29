import { NextResponse } from "next/server";
import { adviseRequestSchema, SYSTEM_PROMPT } from "@/lib/advise";

export const runtime = "nodejs";

const DEFAULT_MODEL = "gpt-4o-mini";

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "AI advisor is not configured. Add OPENAI_API_KEY in Vercel project environment variables.",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = adviseRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid advise payload.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 900,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify(parsed.data, null, 2),
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("OpenAI advise error:", response.status, detail);
      return NextResponse.json(
        { error: "AI service request failed. Try again shortly." },
        { status: 502 },
      );
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };

    const opinion = data.choices?.[0]?.message?.content?.trim();
    if (!opinion) {
      return NextResponse.json(
        { error: "AI returned an empty response." },
        { status: 502 },
      );
    }

    return NextResponse.json({ opinion });
  } catch (error) {
    console.error("Advise route error:", error);
    return NextResponse.json(
      { error: "Unable to reach AI advisor." },
      { status: 500 },
    );
  }
}
