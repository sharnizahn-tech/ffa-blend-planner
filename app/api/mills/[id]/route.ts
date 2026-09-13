import { NextResponse } from "next/server";
import {
  getMillState,
  saveMillState,
  isValidMillId,
  millStateInputSchema,
  MillSaveConflictError,
} from "@/lib/millStore";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidMillId(id)) {
    return NextResponse.json({ error: "Invalid mill link." }, { status: 400 });
  }
  try {
    const state = await getMillState(id);
    if (!state) {
      return NextResponse.json({ error: "No mill found at this link." }, { status: 404 });
    }
    return NextResponse.json(state);
  } catch (error) {
    console.error("Failed to load mill state:", error);
    return NextResponse.json({ error: "Could not load this mill's data. Try again shortly." }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidMillId(id)) {
    return NextResponse.json({ error: "Invalid mill link." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = millStateInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid mill data.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Not part of millStateInputSchema (it's request-level metadata, never
  // persisted) — a client that omits it saves unconditionally.
  const expectedUpdatedAt =
    typeof body === "object" && body !== null && "expectedUpdatedAt" in body
      ? (body as { expectedUpdatedAt?: unknown }).expectedUpdatedAt
      : undefined;

  try {
    const result = await saveMillState(
      id,
      parsed.data,
      typeof expectedUpdatedAt === "string" ? expectedUpdatedAt : undefined,
    );
    return NextResponse.json({ ok: true, updatedAt: result.updatedAt });
  } catch (error) {
    if (error instanceof MillSaveConflictError) {
      return NextResponse.json(
        {
          error: "This mill was updated elsewhere since it was loaded. Reload to see the latest before saving again.",
          currentUpdatedAt: error.currentUpdatedAt,
        },
        { status: 409 },
      );
    }
    console.error("Failed to save mill state:", error);
    return NextResponse.json({ error: "Could not save. Try again shortly." }, { status: 500 });
  }
}
