"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Droplets, Loader2 } from "lucide-react";

export default function LandingPage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setUpMill = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/mills", { method: "POST" });
      if (!res.ok) throw new Error("Could not create a new mill.");
      const data = (await res.json()) as { id: string };
      router.push(`/m/${data.id}`);
    } catch {
      setError("Something went wrong — please try again.");
      setCreating(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#f4f6f2] px-6 text-center text-[#17231d]">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.45)]">
        <Droplets size={28} />
      </div>
      <h1 className="mt-5 text-2xl font-bold sm:text-3xl">Mill Stock Optimizer</h1>
      <p className="mt-2 max-w-md text-sm text-[#58665e] sm:text-base">
        CPO quality decision support for palm oil mills — allocation planning, FFA blending, and
        despatch, all in one place.
      </p>
      <button
        type="button"
        onClick={setUpMill}
        disabled={creating}
        className="btn-touch mt-8 inline-flex items-center gap-2 rounded-full bg-[#00713a] px-6 py-3 text-base font-bold text-white shadow-sm transition hover:bg-[#00602f] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {creating && <Loader2 size={18} className="animate-spin" />}
        {creating ? "Setting up…" : "Set up my mill"}
      </button>
      {error && <p className="mt-3 text-sm text-[#a4342c]">{error}</p>}
      <p className="mt-6 max-w-md text-xs text-[#8a9690]">
        This creates a private link for your mill — bookmark it and share it with your engineers.
        Anyone with that link sees the same live numbers. No account or password needed, so don&apos;t
        lose the link.
      </p>
    </main>
  );
}
