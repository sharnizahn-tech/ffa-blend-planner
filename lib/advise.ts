import { z } from "zod";

const blendPlanSchema = z.object({
  rank: z.number().optional(),
  allocationPct: z.array(z.number()),
  tanks: z.array(
    z.object({
      name: z.string(),
      allocationPct: z.number(),
      incomingMt: z.number(),
      finalStockMt: z.number(),
      finalFfaPct: z.number(),
      utilisationPct: z.number(),
      overflow: z.boolean(),
    }),
  ),
  meetsTarget: z.boolean(),
  score: z.number(),
  maxFinalFfaPct: z.number().optional(),
});

const despatchPlanSchema = z.object({
  rank: z.number().optional(),
  totalMt: z.number(),
  loadFfaPct: z.number(),
  meetsTarget: z.boolean(),
  shortfallMt: z.number(),
  score: z.number(),
  sources: z.array(
    z.object({
      name: z.string(),
      mt: z.number(),
      ffaPct: z.number(),
    }),
  ),
});

export const adviseRequestSchema = z.object({
  production: z.object({
    millCapacityMtHr: z.number(),
    operatingHours: z.number(),
    utilisationPct: z.number(),
    oerPct: z.number(),
    estimatedFfbMt: z.number(),
    incomingCpoMt: z.number(),
    incomingFfaPct: z.number(),
    targetFfaPct: z.number(),
  }),
  tanks: z.array(
    z.object({
      name: z.string(),
      capacityMt: z.number(),
      stockMt: z.number(),
      ffaPct: z.number(),
    }),
  ),
  currentAllocationPct: z.array(z.number()),
  currentPlan: z.array(
    z.object({
      name: z.string(),
      allocationPct: z.number(),
      incomingMt: z.number(),
      finalStockMt: z.number(),
      finalFfaPct: z.number(),
      utilisationPct: z.number(),
      overflow: z.boolean(),
    }),
  ),
  recommendedPlan: blendPlanSchema.nullable(),
  alternativePlans: z.array(blendPlanSchema).optional(),
  despatch: z
    .object({
      tankerLoadMt: z.number(),
      recommendedPlan: despatchPlanSchema.nullable(),
      alternativePlans: z.array(despatchPlanSchema).optional(),
    })
    .optional(),
  flags: z.object({
    allocationTotalPct: z.number(),
    allocationValid: z.boolean(),
    hasOverflow: z.boolean(),
    highFfaStockMt: z.number(),
    currentPlanValid: z.boolean(),
  }),
  userQuestion: z.string().trim().max(500).optional(),
  language: z.enum(["en", "bm"]).optional(),
});

export type AdviseRequest = z.infer<typeof adviseRequestSchema>;

const n = (v: number, d = 1) =>
  v.toLocaleString("en-MY", { minimumFractionDigits: d, maximumFractionDigits: d });

function section(lang: "en" | "bm", headingEn: string, headingBm: string, en: string, ms: string) {
  if (lang === "bm") return `${headingBm}\n\n${ms}`;
  return `${headingEn}\n\n${en}`;
}

export function buildOfflineOpinion(payload: AdviseRequest, lang: "en" | "bm" = "en"): string {
  const {
    production: p,
    flags,
    recommendedPlan,
    alternativePlans,
    despatch,
    currentPlan,
    tanks,
  } = payload;
  const highTanks = tanks.filter((t) => t.ffaPct > p.targetFfaPct).map((t) => t.name);
  const tankList = highTanks.length ? ` (${highTanks.join(", ")})` : "";
  const sections: string[] = [];

  sections.push(
    section(
      lang,
      "Summary",
      "Ringkasan",
      `Expected incoming CPO is ${n(p.incomingCpoMt)} MT from ${n(p.estimatedFfbMt, 0)} MT FFB at ${n(p.incomingFfaPct, 2)}% FFA. Good FFA limit is ${n(p.targetFfaPct, 2)}% — lower is better.`,
      `CPO masuk dijangka ialah ${n(p.incomingCpoMt)} MT daripada ${n(p.estimatedFfbMt, 0)} MT TBS pada ${n(p.incomingFfaPct, 2)}% FFA. Had FFA baik ialah ${n(p.targetFfaPct, 2)}% — lebih rendah lebih baik.`,
    ),
  );

  if (!flags.allocationValid) {
    sections.push(
      section(
        lang,
        "Allocation",
        "Peruntukan",
        `Allocation is ${n(flags.allocationTotalPct, 0)}% — adjust to 100% before transfer.`,
        `Peruntukan ialah ${n(flags.allocationTotalPct, 0)}% — laraskan kepada 100% sebelum pemindahan.`,
      ),
    );
  }

  if (flags.hasOverflow) {
    sections.push(
      section(
        lang,
        "Capacity",
        "Kapasiti",
        "At least one tank would overflow with the current allocation. Reduce percentages or free capacity first.",
        "Sekurang-kurangnya satu tangki akan melimpah dengan peruntukan semasa. Kurangkan peratusan atau kosongkan ruang tangki dahulu.",
      ),
    );
  }

  sections.push(
    section(
      lang,
      "Key risks",
      "Risiko utama",
      flags.highFfaStockMt > 0
        ? `${n(flags.highFfaStockMt, 0)} MT is already above the good FFA limit${tankList}. Avoid feeding more high-FFA CPO into those tanks unless no safer capacity exists.`
        : "No tank currently holds stock above the good FFA limit.",
      flags.highFfaStockMt > 0
        ? `${n(flags.highFfaStockMt, 0)} MT sudah melebihi had FFA baik${tankList}. Elakkan memasukkan lebih banyak CPO FFA tinggi ke tangki tersebut melainkan tiada kapasiti yang lebih selamat.`
        : "Tiada tangki yang menyimpan stok melebihi had FFA baik pada masa ini.",
    ),
  );

  if (recommendedPlan) {
    const formatPlan = (plan: NonNullable<AdviseRequest["recommendedPlan"]>, label: string) => {
      const parts = plan.tanks
        .filter((t) => t.allocationPct > 0)
        .map(
          (t) =>
            `${t.name}: ${t.allocationPct}% (${n(t.incomingMt)} MT → final FFA ${n(t.finalFfaPct, 2)}%)`,
        );
      const planText = parts.join("; ");
      const maxFfa = plan.maxFinalFfaPct ?? Math.max(...plan.tanks.map((t) => t.finalFfaPct));
      const status = plan.meetsTarget
        ? lang === "bm"
          ? "dalam had FFA baik"
          : "within the good FFA limit"
        : lang === "bm"
          ? `FFA akhir tertinggi ${n(maxFfa, 2)}%`
          : `highest final FFA ${n(maxFfa, 2)}%`;
      return lang === "bm"
        ? `${label} (${status}): ${planText}.`
        : `${label} (${status}): ${planText}.`;
    };

    const ranked = [
      recommendedPlan,
      ...(alternativePlans ?? []),
    ] as NonNullable<AdviseRequest["recommendedPlan"]>[];

    sections.push(
      section(
        lang,
        "Recommended action",
        "Tindakan disyorkan",
        ranked.map((plan, i) => formatPlan(plan, i === 0 ? "Best plan" : `Plan ${i + 1}`)).join(" "),
        ranked
          .map((plan, i) => formatPlan(plan, i === 0 ? "Pelan terbaik" : `Pelan ${i + 1}`))
          .join(" "),
      ),
    );

    const differs = currentPlan.some(
      (t, i) => t.allocationPct !== (recommendedPlan.allocationPct[i] ?? 0),
    );
    if (differs) {
      sections.push(
        section(
          lang,
          "Manual vs recommended",
          "Manual vs disyorkan",
          "Current manual allocation differs from the recommended plan — review before transfer.",
          "Peruntukan manual semasa berbeza daripada pelan disyorkan — semak sebelum pemindahan.",
        ),
      );
    }
  } else {
    sections.push(
      section(
        lang,
        "Recommended action",
        "Tindakan disyorkan",
        "No feasible allocation fits available tank capacity with expected incoming CPO.",
        "Tiada peruntukan yang munasabah muat dalam kapasiti tangki available dengan CPO masuk dijangka.",
      ),
    );
  }

  if (despatch) {
    const formatDespatch = (
      plan: NonNullable<NonNullable<AdviseRequest["despatch"]>["recommendedPlan"]>,
      label: string,
    ) => {
      const parts = plan.sources.map((s) => `${s.name}: ${n(s.mt)} MT (${n(s.ffaPct, 2)}% FFA)`);
      const status = plan.meetsTarget
        ? lang === "bm"
          ? "dalam had FFA baik"
          : "within the good FFA limit"
        : lang === "bm"
          ? `FFA muatan ${n(plan.loadFfaPct, 2)}%`
          : `load FFA ${n(plan.loadFfaPct, 2)}%`;
      const shortfall =
        plan.shortfallMt > 0
          ? lang === "bm"
            ? ` Kurang ${n(plan.shortfallMt)} MT.`
            : ` Short ${n(plan.shortfallMt)} MT.`
          : "";
      return lang === "bm"
        ? `${label} (${status}, ${n(plan.totalMt)} MT): ${parts.join("; ")}.${shortfall}`
        : `${label} (${status}, ${n(plan.totalMt)} MT): ${parts.join("; ")}.${shortfall}`;
    };

    if (despatch.recommendedPlan) {
      const ranked = [
        despatch.recommendedPlan,
        ...(despatch.alternativePlans ?? []),
      ] as NonNullable<NonNullable<AdviseRequest["despatch"]>["recommendedPlan"]>[];

      sections.push(
        section(
          lang,
          "Tanker despatch",
          "Despatch tanker",
          `Tanker load target is ${n(despatch.tankerLoadMt)} MT from post-blend stock. ${ranked
            .map((plan, i) => formatDespatch(plan, i === 0 ? "Best despatch" : `Despatch ${i + 1}`))
            .join(" ")}`,
          `Sasaran muatan tanker ialah ${n(despatch.tankerLoadMt)} MT daripada stok selepas campuran. ${ranked
            .map((plan, i) =>
              formatDespatch(plan, i === 0 ? "Despatch terbaik" : `Despatch ${i + 1}`),
            )
            .join(" ")}`,
        ),
      );
    } else {
      sections.push(
        section(
          lang,
          "Tanker despatch",
          "Despatch tanker",
          `No tanker despatch plan for ${n(despatch.tankerLoadMt)} MT — check post-blend stock after allocation.`,
          `Tiada pelan despatch tanker untuk ${n(despatch.tankerLoadMt)} MT — semak stok selepas campuran selepas peruntukan.`,
        ),
      );
    }
  }

  sections.push(
    section(
      lang,
      "Before transfer",
      "Sebelum pemindahan",
      "Verify latest dipping, laboratory FFA, available capacity, and valve routing. This offline summary is decision support only — authorised engineer verification is required before transfer.",
      "Sahkan dipping tangki terkini, FFA makmal, kapasiti available, dan laluan injap. Ringkasan luar talian ini ialah sokongan keputusan sahaja — pengesahan jurutera berwibawa diperlukan sebelum pemindahan.",
    ),
  );

  return sections.join("\n\n");
}

export function buildSystemPrompt(lang: "en" | "bm", userQuestion?: string) {
  const languageRule =
    lang === "bm"
      ? "Write your entire response in Bahasa Melayu. Use natural Malaysian mill terminology (TBS, tangki, FFA, CPO, dipping, injap)."
      : "Write your entire response in English.";

  const questionRule = userQuestion
    ? `The engineer asked: "${userQuestion}". Answer this question first using only the provided data, then give brief supporting context from the plan.`
    : "Give a structured opinion covering summary, key risks, recommended allocation, tanker despatch (if provided), and before-transfer checks.";

  return `You are a senior palm oil mill CPO blending advisor supporting engineers at a Malaysian mill.

Rules:
- Use ONLY the numbers and flags provided in the user message. Never invent tank readings, percentages, or MT values.
- The recommendedPlan is rank 1; alternativePlans (if present) are ranks 2–3 from the same engine. Treat recommendedPlan as the mathematical best unless flags show it is infeasible.
- When alternativePlans are provided, briefly compare how plans 2 and 3 differ and when an engineer might choose them over plan 1.
- despatch (if present) covers tanker loading from post-blend stock. recommendedPlan is the best despatch option; alternativePlans are ranks 2–3. Mention which tanks to load, blended load FFA, and shortfall if the tanker cannot be fully filled.
- When despatch data is provided, include tanker loading advice alongside blend allocation advice when relevant to the engineer's question.
- targetFfaPct is the GOOD FFA LIMIT (maximum for good quality), not a target to hit. FFA lower than this limit is better; 4.8% means at or below 4.8% is good, and lower values are preferable.
- Explain WHY the recommended allocation is best, which tanks are risky, and what operational actions the engineer should take before transfer.
- Compare currentPlan vs recommendedPlan when they differ.
- If recommendedPlan is null, explain why no feasible plan exists and what constraints block a solution.
- If hasOverflow is true or allocationValid is false, say so clearly first.
- Mention lab verification, dipping, valve routing, and despatch/hold options when relevant.
- ${languageRule}
- ${questionRule}
- Use short sections with plain headings appropriate to the response language.
- Write plain text only. Do not use asterisks, markdown, bullet symbols, or other formatting markers.
- Keep tank names (e.g. BST 1) unchanged.
- Keep the tone professional, concise, and practical for shift engineers.
- End with one sentence: this is decision support only — authorised engineer verification is required before transfer.
- Do not approve transfers. Do not output JSON.`;
}
