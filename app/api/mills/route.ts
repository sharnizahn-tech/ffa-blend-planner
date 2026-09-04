import { NextResponse } from "next/server";
import { createMill } from "@/lib/millStore";

export const runtime = "nodejs";

/** Creates a new mill (fresh demo data) and returns its ID — the caller
 *  redirects to /m/<id>, which becomes that mill's permanent link. */
export async function POST() {
  try {
    const id = await createMill();
    return NextResponse.json({ id });
  } catch (error) {
    console.error("Failed to create mill:", error);
    return NextResponse.json({ error: "Could not create a new mill. Try again shortly." }, { status: 500 });
  }
}
