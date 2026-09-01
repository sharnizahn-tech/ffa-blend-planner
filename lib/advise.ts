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
  penaltyRm: z.number().optional(),
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
  penalty: z
    .object({
      buyerName: z.string().nullable(),
      totalExposureRm: z.number(),
      perTank: z.array(
        z.object({ name: z.string(), rmPerMt: z.number(), totalRm: z.number() }),
      ),
    })
    .nullable()
    .optional(),
  prediction: z
    .object({
      riseFactorPerDay: z.number(),
      horizonDays: z.number(),
      tanks: z.array(
        z.object({ name: z.string(), daysUntilLimit: z.number().nullable() }),
      ),
    })
    .nullable()
    .optional(),
  productionSuggestion: z
    .object({
      maxSafeIncomingCpoMt: z.number(),
      binding: z.enum(["capacity", "ffa", "none"]),
      suggestedHoursAtCurrentUtilisation: z.number().nullable(),
      suggestedUtilisationPctAtCurrentHours: z.number().nullable(),
    })
    .nullable()
    .optional(),
  lossOptimizer: z
    .array(
      z.object({
        tankName: z.string(),
        despatchNowPenaltyRm: z.number(),
        holdFeasible: z.boolean(),
        holdDays: z.number().nullable(),
        holdPenaltyRm: z.number(),
        savingsRm: z.number(),
        recommendation: z.enum(["hold", "despatchNow"]),
      }),
    )
    .optional(),
  batchBlend: z
    .object({
      feasible: z.boolean(),
      days: z.number().nullable(),
      reason: z.string().nullable(),
      steps: z.array(
        z.object({ day: z.number(), fromTank: z.string(), toTank: z.string(), mt: z.number() }),
      ),
    })
    .nullable()
    .optional(),
  conversationHistory: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(20)
    .optional(),
  userQuestion: z.string().trim().max(500).optional(),
  language: z.enum(["en", "bm"]).optional(),
  deepAnalysis: z.boolean().optional(),
});

export type AdviseRequest = z.infer<typeof adviseRequestSchema>;

const n = (v: number, d = 2) =>
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
    penalty,
    prediction,
    productionSuggestion,
    lossOptimizer,
    batchBlend,
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
      const penaltyText =
        plan.penaltyRm !== undefined
          ? lang === "bm"
            ? ` Anggaran penalti: RM ${n(plan.penaltyRm, 0)}.`
            : ` Estimated penalty: RM ${n(plan.penaltyRm, 0)}.`
          : "";
      return `${label} (${status}): ${planText}.${penaltyText}`;
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

  if (penalty && penalty.totalExposureRm > 0) {
    const worst = [...penalty.perTank].sort((a, b) => b.totalRm - a.totalRm).slice(0, 3);
    const parts = worst
      .filter((t) => t.totalRm > 0)
      .map((t) => `${t.name}: RM ${n(t.totalRm, 0)} (RM ${n(t.rmPerMt, 0)}/MT)`)
      .join("; ");
    sections.push(
      section(
        lang,
        "Penalty exposure",
        "Pendedahan penalti",
        `Estimated deduction from ${penalty.buyerName ?? "the configured buyer"}: RM ${n(penalty.totalExposureRm, 0)} at current plan. ${parts}.`,
        `Anggaran potongan daripada ${penalty.buyerName ?? "pembeli dikonfigurasi"}: RM ${n(penalty.totalExposureRm, 0)} pada pelan semasa. ${parts}.`,
      ),
    );
  }

  if (prediction) {
    const atRisk = prediction.tanks.filter((t) => t.daysUntilLimit !== null);
    if (atRisk.length) {
      const parts = atRisk
        .map((t) => `${t.name}: ${t.daysUntilLimit} day(s)`)
        .join("; ");
      const partsBm = atRisk
        .map((t) => `${t.name}: ${t.daysUntilLimit} hari`)
        .join("; ");
      sections.push(
        section(
          lang,
          "FFA forecast",
          "Ramalan FFA",
          `At the configured rise rate, projected days until crossing the good FFA limit: ${parts}.`,
          `Pada kadar kenaikan dikonfigurasi, hari dijangka sehingga melebihi had FFA baik: ${partsBm}.`,
        ),
      );
    }
  }

  if (productionSuggestion && productionSuggestion.binding !== "none") {
    const bindingText =
      productionSuggestion.binding === "capacity"
        ? { en: "tank capacity", bm: "kapasiti tangki" }
        : { en: "the good FFA limit", bm: "had FFA baik" };
    sections.push(
      section(
        lang,
        "Production ceiling",
        "Siling pengeluaran",
        `Safe incoming CPO is capped near ${n(productionSuggestion.maxSafeIncomingCpoMt)} MT, limited by ${bindingText.en}.`,
        `CPO masuk selamat dihadkan sekitar ${n(productionSuggestion.maxSafeIncomingCpoMt)} MT, dihadkan oleh ${bindingText.bm}.`,
      ),
    );
  }

  if (lossOptimizer && lossOptimizer.length) {
    const parts = lossOptimizer
      .map((t) =>
        t.recommendation === "hold"
          ? `${t.tankName}: hold ${t.holdDays} day(s), avoid RM ${n(t.savingsRm, 0)} (would be RM ${n(t.despatchNowPenaltyRm, 0)} if despatched now)`
          : `${t.tankName}: despatch now — no feasible dilution avoids the RM ${n(t.despatchNowPenaltyRm, 0)} penalty in time`,
      )
      .join("; ");
    const partsBm = lossOptimizer
      .map((t) =>
        t.recommendation === "hold"
          ? `${t.tankName}: tahan ${t.holdDays} hari, elak RM ${n(t.savingsRm, 0)} (akan jadi RM ${n(t.despatchNowPenaltyRm, 0)} jika despatch sekarang)`
          : `${t.tankName}: despatch sekarang — tiada pencairan munasabah dalam masa untuk elak penalti RM ${n(t.despatchNowPenaltyRm, 0)}`,
      )
      .join("; ");
    const totalSavings = lossOptimizer.reduce((s, t) => s + (t.recommendation === "hold" ? t.savingsRm : 0), 0);
    sections.push(
      section(
        lang,
        "Sell now vs hold",
        "Jual sekarang vs tahan",
        `${parts}. Total potential savings if followed: RM ${n(totalSavings, 0)}.`,
        `${partsBm}. Jumlah potensi jimat jika diikuti: RM ${n(totalSavings, 0)}.`,
      ),
    );
  }

  if (batchBlend) {
    const status = batchBlend.feasible
      ? batchBlend.days === 0
        ? { en: "already ready to dispatch.", bm: "sudah sedia untuk despatch." }
        : {
            en: `ready to dispatch after ${batchBlend.days} day(s) of tank-to-tank blending.`,
            bm: `sedia untuk despatch selepas ${batchBlend.days} hari campuran tangki-ke-tangki.`,
          }
      : { en: `not feasible within the planning horizon (${batchBlend.reason ?? "unknown reason"}).`, bm: `tidak munasabah dalam tempoh perancangan (${batchBlend.reason ?? "sebab tidak diketahui"}).` };
    sections.push(
      section(
        lang,
        "Batch blend (no daily processing)",
        "Campuran kelompok (tiada proses harian)",
        `Selected tanks are ${status.en}`,
        `Tangki dipilih ${status.bm}`,
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

export function buildSystemPrompt(
  lang: "en" | "bm",
  userQuestion?: string,
  deepAnalysis?: boolean,
  hasHistory?: boolean,
) {
  const languageRule =
    lang === "bm"
      ? "Write your entire response in Bahasa Melayu. Use natural Malaysian mill terminology (TBS, tangki, FFA, CPO, dipping, injap)."
      : "Write your entire response in English.";

  const questionRule = userQuestion
    ? `The engineer asked: "${userQuestion}". Answer this question first using only the provided data, then give brief supporting context from the plan.`
    : deepAnalysis
      ? "Give a full structured analysis: summary, key risks, penalty exposure impact (if provided), FFA forecast/early-warning (if provided), production ceiling (if provided), recommended allocation, tanker despatch (if provided), and before-transfer checks. Be thorough but concise."
      : "Give a structured opinion covering summary, key risks, recommended allocation, tanker despatch (if provided), and before-transfer checks.";

  const historyRule = hasHistory
    ? "The user message includes a conversationHistory array of prior turns in this session. Treat it as context — do not repeat earlier points verbatim, answer the latest question in light of what was already discussed."
    : "";

  return `You are a senior palm oil mill CPO blending advisor supporting engineers at a Malaysian mill.

Rules:
- Use ONLY the numbers and flags provided in the user message. Never invent tank readings, percentages, RM figures, or MT values.
- The recommendedPlan is rank 1; alternativePlans (if present) are ranks 2–3 from the same engine. Treat recommendedPlan as the mathematical best unless flags show it is infeasible.
- When alternativePlans are provided, briefly compare how plans 2 and 3 differ and when an engineer might choose them over plan 1.
- despatch (if present) covers tanker loading from post-blend stock. recommendedPlan is the best despatch option; alternativePlans are ranks 2–3. Mention which tanks to load, blended load FFA, and shortfall if the tanker cannot be fully filled.
- When despatch data is provided, include tanker loading advice alongside blend allocation advice when relevant to the engineer's question.
- penalty (if provided) is the estimated RM deduction from the engineer's own configured buyer penalty bands — cite the totalExposureRm and worst tanks exactly as given, never estimate your own RM figure.
- prediction (if provided) is a forward FFA projection using the engineer's own configured rise-rate assumption — cite daysUntilLimit values as given; do not invent a different timeline.
- productionSuggestion (if provided) is the engine's calculated safe incoming CPO ceiling and which constraint (capacity or FFA limit) binds it — reference it when discussing production planning, do not recompute your own number.
- lossOptimizer (if provided) is a per-tank comparison, already computed by the engine, of despatching a high-FFA tank now (despatchNowPenaltyRm) versus holding it and diluting the FFA down first (holdFeasible, holdDays, holdPenaltyRm, savingsRm, recommendation). Always state the engine's recommendation and the RM savings figure exactly as given — this is the core "should we sell now or hold" decision the engineer needs; do not soften it into vague advice.
- batchBlend (if provided) is the engine's day-by-day tank-to-tank transfer plan for bringing existing stock to good FFA without any new incoming CPO (for mills not running daily). Cite feasible/days/steps exactly as given.
- Each blend/despatch plan may include penaltyRm — the estimated RM deduction for that specific plan under the engineer's configured buyer profile. When comparing plans, mention the penalty difference between them, not just the FFA difference.
- targetFfaPct is the GOOD FFA LIMIT (maximum for good quality), not a target to hit. FFA lower than this limit is better; 4.8% means at or below 4.8% is good, and lower values are preferable.
- Explain WHY the recommended allocation is best, which tanks are risky, and what operational actions the engineer should take before transfer.
- Compare currentPlan vs recommendedPlan when they differ.
- If recommendedPlan is null, explain why no feasible plan exists and what constraints block a solution.
- If hasOverflow is true or allocationValid is false, say so clearly first.
- Mention lab verification, dipping, valve routing, and despatch/hold options when relevant.
- ${languageRule}
- ${questionRule}
- ${historyRule}
- Use short sections with plain headings appropriate to the response language.
- Write plain text only. Do not use asterisks, markdown, bullet symbols, or other formatting markers.
- Keep tank names (e.g. BST 1) unchanged.
- Keep the tone professional, concise, and practical for shift engineers.
- End with one sentence: this is decision support only — authorised engineer verification is required before transfer.
- Do not approve transfers. Do not output JSON.`;
}
