import { NextResponse } from "next/server";
import {
  adviseRequestSchema,
  buildOfflineOpinion,
  SYSTEM_PROMPT,
  type AdviseRequest,
} from "@/lib/advise";

export const runtime = "nodejs";

const DEFAULT_BASE_URL = "https://www.chenzk.top/v1";
const FALLBACK_MODELS = ["gpt-5.4", "gpt-4o-mini", "gpt-4o"];

function parseOpenAiError(detailText: string) {
  try {
    return JSON.parse(detailText) as {
      error?: { message?: string; code?: string; type?: string };
    };
  } catch {
    return null;
  }
}

function openAiErrorMessage(status: number, detailText: string): string {
  const detail = parseOpenAiError(detailText);
  const message = detail?.error?.message ?? "";
  const code = detail?.error?.code ?? "";

  if (status === 401 || code === "invalid_api_key") {
    return "Invalid OpenAI API key. Check OPENAI_API_KEY in Vercel.";
  }
  if (code === "insufficient_quota" || message.toLowerCase().includes("quota")) {
    return "OpenAI account or proxy has no available credits.";
  }
  if (status === 429) {
    return "OpenAI rate limit reached. Wait 60 seconds, tap once only, then try again.";
  }
  if (code === "model_not_found") {
    return "OpenAI model unavailable. Set OPENAI_MODEL to gpt-4o-mini in Vercel or remove that variable.";
  }
  if (message) return message;

  return "AI service request failed. Try again shortly.";
}

function shouldTryNextModel(status: number, detailText: string): boolean {
  const lower = detailText.toLowerCase();
  const code = parseOpenAiError(detailText)?.error?.code ?? "";

  return (
    status === 404 ||
    status === 429 ||
    status === 503 ||
    code === "model_not_found" ||
    lower.includes("high demand") ||
    lower.includes("not found") ||
    lower.includes("unavailable")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenAiBaseUrl() {
  return (process.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

async function callOpenAi(
  apiKey: string,
  baseUrl: string,
  model: string,
  userContent: string,
) {
  return fetch(`${baseUrl}/chat/completions`, {
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
        { role: "user", content: userContent },
      ],
    }),
  });
}

async function requestOpenAiOpinion(
  apiKey: string,
  baseUrl: string,
  models: string[],
  userContent: string,
): Promise<{ opinion: string; source: "openai" } | { error: string }> {
  let lastDetail = "";
  let lastStatus = 502;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await callOpenAi(apiKey, baseUrl, model, userContent);

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: { message?: { content?: string | null } }[];
        };
        const opinion = data.choices?.[0]?.message?.content?.trim();
        if (opinion) return { opinion, source: "openai" };
        lastDetail = "empty response";
        lastStatus = 502;
        break;
      }

      lastDetail = await response.text();
      lastStatus = response.status;
      console.error("OpenAI advise error:", response.status, model, lastDetail);

      if (!shouldTryNextModel(response.status, lastDetail)) {
        return { error: openAiErrorMessage(response.status, lastDetail) };
      }

      if (attempt === 0) await sleep(1500);
    }
  }

  return { error: openAiErrorMessage(lastStatus, lastDetail) };
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
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

  const payload: AdviseRequest = parsed.data;
  const baseUrl = getOpenAiBaseUrl();
  const configuredModel = process.env.OPENAI_MODEL?.trim();
  const models = configuredModel
    ? [configuredModel, ...FALLBACK_MODELS.filter((model) => model !== configuredModel)]
    : FALLBACK_MODELS;

  try {
    const userContent = JSON.stringify(payload, null, 2);
    const result = await requestOpenAiOpinion(apiKey, baseUrl, models, userContent);

    if ("opinion" in result) {
      return NextResponse.json(result);
    }

    const offlineOpinion = buildOfflineOpinion(payload);
    return NextResponse.json({
      opinion: `${offlineOpinion}\n\nNote / Nota: OpenAI was unavailable (${result.error}). This summary was generated offline from your calculated plan.\nOpenAI tidak tersedia (${result.error}). Ringkasan ini dijana luar talian daripada pelan yang dikira.`,
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
