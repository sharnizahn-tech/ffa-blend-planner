import { NextResponse } from "next/server";
import { adviseRequestSchema, SYSTEM_PROMPT } from "@/lib/advise";

export const runtime = "nodejs";

const FALLBACK_MODELS = [
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.5-flash",
];

function geminiErrorMessage(status: number, detailText: string): string {
  try {
    const detail = JSON.parse(detailText) as {
      error?: { message?: string; code?: number; status?: string };
    };
    const message = detail.error?.message ?? "";
    const code = detail.error?.status ?? "";

    if (status === 400 && message.toLowerCase().includes("api key")) {
      return "Invalid Gemini API key. In Vercel, check GEMINI_API_KEY matches your key from aistudio.google.com/apikey.";
    }
    if (status === 403 || code === "PERMISSION_DENIED") {
      return "Gemini API access denied. Enable the Generative Language API and verify GEMINI_API_KEY.";
    }
    if (status === 429 || code === "RESOURCE_EXHAUSTED") {
      return "Gemini rate limit reached. Wait 60 seconds, tap once only, then try again.";
    }
    if (code === "NOT_FOUND") {
      return "Gemini model unavailable. In Vercel, delete GEMINI_MODEL if set, redeploy, then try again.";
    }
    if (message) return message;
  } catch {
    // Fall through to generic message.
  }

  return "AI service request failed. Try again shortly.";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(apiKey: string, model: string, userContent: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userContent }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 900,
      },
    }),
  });
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "AI advisor is not configured. Add GEMINI_API_KEY in Vercel project environment variables.",
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

  const configuredModel = process.env.GEMINI_MODEL?.trim();
  const isDeprecatedModel =
    !configuredModel ||
    configuredModel.includes("1.5-flash") ||
    configuredModel.includes("2.0-flash");
  const models = isDeprecatedModel
    ? FALLBACK_MODELS
    : [configuredModel, ...FALLBACK_MODELS.filter((model) => model !== configuredModel)];

  try {
    const userContent = JSON.stringify(parsed.data, null, 2);
    let response: Response | null = null;
    let lastDetail = "";

    for (const model of models) {
      response = await callGemini(apiKey, model, userContent);

      if (response.status === 429) {
        await sleep(2500);
        response = await callGemini(apiKey, model, userContent);
      }

      if (response.ok) break;

      lastDetail = await response.text();
      console.error("Gemini advise error:", response.status, model, lastDetail);

      const isModelMissing =
        response.status === 404 ||
        lastDetail.includes("NOT_FOUND") ||
        lastDetail.toLowerCase().includes("not found");

      if (!isModelMissing || models.length === 1) {
        return NextResponse.json(
          { error: geminiErrorMessage(response.status, lastDetail) },
          { status: 502 },
        );
      }
    }

    if (!response?.ok) {
      return NextResponse.json(
        { error: geminiErrorMessage(response?.status ?? 502, lastDetail) },
        { status: 502 },
      );
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const opinion = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
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
