import { NextResponse } from "next/server";
import {
  adviseRequestSchema,
  buildOfflineOpinion,
  SYSTEM_PROMPT,
  type AdviseRequest,
} from "@/lib/advise";

export const runtime = "nodejs";

const FALLBACK_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-flash-latest",
];

function parseGeminiError(detailText: string) {
  try {
    return JSON.parse(detailText) as {
      error?: { message?: string; code?: number; status?: string };
    };
  } catch {
    return null;
  }
}

function geminiErrorMessage(status: number, detailText: string): string {
  const detail = parseGeminiError(detailText);
  const message = detail?.error?.message ?? "";
  const code = detail?.error?.status ?? "";

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

  return "AI service request failed. Try again shortly.";
}

function shouldTryNextModel(status: number, detailText: string): boolean {
  const lower = detailText.toLowerCase();
  const code = parseGeminiError(detailText)?.error?.status ?? "";

  return (
    status === 404 ||
    status === 429 ||
    status === 503 ||
    code === "NOT_FOUND" ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "UNAVAILABLE" ||
    lower.includes("high demand") ||
    lower.includes("not found") ||
    lower.includes("unavailable")
  );
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

async function requestGeminiOpinion(
  apiKey: string,
  models: string[],
  userContent: string,
): Promise<{ opinion: string; source: "gemini" } | { error: string }> {
  let lastDetail = "";
  let lastStatus = 502;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await callGemini(apiKey, model, userContent);

      if (response.ok) {
        const data = (await response.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const opinion = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (opinion) return { opinion, source: "gemini" };
        lastDetail = "empty response";
        lastStatus = 502;
        break;
      }

      lastDetail = await response.text();
      lastStatus = response.status;
      console.error("Gemini advise error:", response.status, model, lastDetail);

      if (!shouldTryNextModel(response.status, lastDetail)) {
        return { error: geminiErrorMessage(response.status, lastDetail) };
      }

      if (attempt === 0) await sleep(1500);
    }
  }

  return { error: geminiErrorMessage(lastStatus, lastDetail) };
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

  const payload: AdviseRequest = parsed.data;
  const configuredModel = process.env.GEMINI_MODEL?.trim();
  const isDeprecatedModel =
    !configuredModel ||
    configuredModel.includes("1.5-flash") ||
    configuredModel.includes("2.0-flash");
  const models = isDeprecatedModel
    ? FALLBACK_MODELS
    : [configuredModel, ...FALLBACK_MODELS.filter((model) => model !== configuredModel)];

  try {
    const userContent = JSON.stringify(payload, null, 2);
    const result = await requestGeminiOpinion(apiKey, models, userContent);

    if ("opinion" in result) {
      return NextResponse.json(result);
    }

    const offlineOpinion = buildOfflineOpinion(payload);
    return NextResponse.json({
      opinion: `${offlineOpinion}\n\nNote: Gemini AI was busy (${result.error}). This summary was generated offline from your calculated plan.`,
      source: "offline",
    });
  } catch (error) {
    console.error("Advise route error:", error);
    return NextResponse.json({
      opinion: buildOfflineOpinion(payload),
      source: "offline",
    });
  }
}
