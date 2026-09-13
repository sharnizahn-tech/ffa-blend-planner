import { NextResponse } from "next/server";
import { isValidMillId, undoLastSave } from "@/lib/millStore";

export const runtime = "nodejs";

/** Restores the mill to whatever was live just before its most recent
 *  save — one level of undo, not a redo-able stack. 404 means there's
 *  nothing to undo (no prior save, or undo already used since then). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidMillId(id)) {
    return NextResponse.json({ error: "Invalid mill link." }, { status: 400 });
  }
  try {
    const restored = await undoLastSave(id);
    if (!restored) {
      return NextResponse.json({ error: "Nothing to undo." }, { status: 404 });
    }
    return NextResponse.json(restored);
  } catch (error) {
    console.error("Failed to undo mill save:", error);
    return NextResponse.json({ error: "Could not undo. Try again shortly." }, { status: 500 });
  }
}
