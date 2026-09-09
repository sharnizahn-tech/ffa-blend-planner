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
  // Optional (not required) so a browser running slightly-stale cached
  // frontend code — from just before this field was introduced — doesn't
  // get its entire advise request hard-rejected; it just loses the
  // relative-ranking commentary for that one call instead.
  scoreDeltaPct: z.number().optional(),
  maxFinalFfaPct: z.number().optional(),
  penaltyRm: z.number().optional(),
});

const despatchPlanSchema = z.object({
  rank: z.number().optional(),
  totalMt: z.number(),
  loadFfaPct: z.number(),
  meetsTarget: z.boolean(),
  shortfallMt: z.number(),
  scoreDeltaPct: z.number().optional(),
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
      plannedDespatchTotalMt: z.number().optional(),
      plannedDespatchTotalLorries: z.number().optional(),
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
        bestDay: z.number().optional(),
        bestDayFfaPct: z.number().optional(),
        bestDayFullyCompliant: z.boolean().optional(),
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
  incomingAsSource: z
    .object({
      included: z.boolean(),
      availableMt: z.number(),
      ffaPct: z.number(),
    })
    .optional(),
  conversationHistory: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(20)
    .optional(),
  // 900, not 500: the engineer's own free-typed question is separately
  // capped at 500 chars by the Ask AI textarea's maxLength, but this field
  // is reused for the Allocation strategy card's internally-built question
  // (a long templated sentence plus the "lay out real alternatives as
  // Option 1/2" hint appended to it), which can run past 500 on its own.
  userQuestion: z.string().trim().max(900).optional(),
  language: z.enum(["en", "bm"]).optional(),
  deepAnalysis: z.boolean().optional(),
  // Engineer tapped "Quick summary" instead of Ask AI / Full analysis — reply
  // in short bullet points instead of paragraphs. Mutually exclusive with
  // deepAnalysis in practice (separate buttons), but if both are somehow set,
  // concise wins.
  concise: z.boolean().optional(),
  // Which tab the engineer is actually looking at right now, so a question
  // asked from the Despatch tab gets a despatch-focused answer instead of a
  // generic one — every tab's data is always included regardless.
  currentTab: z.enum(["overview", "production", "despatch", "transfer"]).optional(),
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
      .map((t) => {
        if (t.recommendation !== "hold") {
          return `${t.tankName}: despatch now — no feasible blend avoids or reduces the RM ${n(t.despatchNowPenaltyRm, 0)} penalty in time`;
        }
        const day = t.bestDay ?? t.holdDays ?? 0;
        return t.bestDayFullyCompliant === false
          ? `${t.tankName}: hold ${day} day(s) to reach a cheaper penalty band (still above the limit at ${n(t.bestDayFfaPct ?? 0, 2)}% FFA), saving RM ${n(t.savingsRm, 0)} versus despatching now (RM ${n(t.despatchNowPenaltyRm, 0)})`
          : `${t.tankName}: hold ${day} day(s), avoid RM ${n(t.savingsRm, 0)} (would be RM ${n(t.despatchNowPenaltyRm, 0)} if despatched now)`;
      })
      .join("; ");
    const partsBm = lossOptimizer
      .map((t) => {
        if (t.recommendation !== "hold") {
          return `${t.tankName}: despatch sekarang — tiada blend munasabah dalam masa untuk elak atau kurangkan penalti RM ${n(t.despatchNowPenaltyRm, 0)}`;
        }
        const day = t.bestDay ?? t.holdDays ?? 0;
        return t.bestDayFullyCompliant === false
          ? `${t.tankName}: tahan ${day} hari untuk capai band penalti lebih murah (masih melebihi had pada ${n(t.bestDayFfaPct ?? 0, 2)}% FFA), jimat RM ${n(t.savingsRm, 0)} berbanding despatch sekarang (RM ${n(t.despatchNowPenaltyRm, 0)})`
          : `${t.tankName}: tahan ${day} hari, elak RM ${n(t.savingsRm, 0)} (akan jadi RM ${n(t.despatchNowPenaltyRm, 0)} jika despatch sekarang)`;
      })
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
        ? { en: "already ready to despatch.", bm: "sudah sedia untuk despatch." }
        : {
            en: `ready to despatch after ${batchBlend.days} day(s) of tank-to-tank transfers.`,
            bm: `sedia untuk despatch selepas ${batchBlend.days} hari pemindahan tangki-ke-tangki.`,
          }
      : { en: `not feasible within the planning horizon (${batchBlend.reason ?? "unknown reason"}).`, bm: `tidak munasabah dalam tempoh perancangan (${batchBlend.reason ?? "sebab tidak diketahui"}).` };
    sections.push(
      section(
        lang,
        "Batch transfer (no daily processing)",
        "Pemindahan kelompok (tiada proses harian)",
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
          `Tanker load target is ${n(despatch.tankerLoadMt)} MT from post-allocation stock. ${ranked
            .map((plan, i) => formatDespatch(plan, i === 0 ? "Best despatch" : `Despatch ${i + 1}`))
            .join(" ")}`,
          `Sasaran muatan tanker ialah ${n(despatch.tankerLoadMt)} MT daripada stok selepas peruntukan. ${ranked
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
          `No tanker despatch plan for ${n(despatch.tankerLoadMt)} MT — check post-allocation stock after allocation.`,
          `Tiada pelan despatch tanker untuk ${n(despatch.tankerLoadMt)} MT — semak stok selepas peruntukan.`,
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
  currentTab?: "overview" | "production" | "despatch" | "transfer",
  concise?: boolean,
) {
  const languageRule =
    lang === "bm"
      ? "Write your entire response in Bahasa Melayu. Use natural Malaysian mill terminology (TBS, tangki, FFA, CPO, dipping, injap)."
      : "Write your entire response in English.";

  // "Ask AI" (no question typed) and "Full analysis" must read as genuinely
  // different things, not the same prompt at two lengths: Ask AI is a quick
  // take an engineer can read in ten seconds; Full analysis is the report
  // they'd print before a shift handover. "Quick summary" is a third,
  // orthogonal mode — same depth as Ask AI, but bullet points instead of
  // paragraphs, for an engineer who wants to skim it in five seconds.
  const questionRule = concise
    ? userQuestion
      ? `The engineer asked: "${userQuestion}" and tapped QUICK SUMMARY — they want this skimmed in five seconds, not read. Answer the question directly as the first bullet, then only the specific numbers/reasons that back it up.`
      : "This is QUICK SUMMARY mode — the engineer wants the shortest possible skim: what's happening today, the recommended move, and the one thing to do next."
    : userQuestion
      ? deepAnalysis
        ? `The engineer asked: "${userQuestion}" and tapped FULL ANALYSIS, not the quick Ask AI button — they specifically want the deep version of this answer. Answer the question directly in the first sentence, then go well beyond just that question: full reasoning behind the answer, plus the wider picture as far as it's relevant — penalty/cost exposure, the sell-now-vs-hold call for any tank over the limit, the forecast, and what to verify before transfer. Genuinely use the extra room; this must read as more complete than a quick answer, not the same length with a different label.`
        : `The engineer asked: "${userQuestion}". Answer it directly in the first sentence, then give only the specific numbers and reasoning that back that answer up — explain WHY, not just what. Keep it to the quick ASK AI depth — a few short paragraphs, not the full report (that's what Full analysis is for). If the question asks for a length (e.g. "2-3 sentences"), treat that as a floor, not a ceiling: stay close to it but don't cut a genuinely necessary reason just to hit a word count. Do not pad the response with an extra "supporting context" section covering unrelated data fields.`
      : deepAnalysis
        ? "This is the FULL ANALYSIS mode — the engineer wants the complete picture, not a quick take. Cover, in flowing paragraphs (not a checklist): the situation today, the key risk and why it matters, the recommended move with full reasoning, the penalty/cost picture if a buyer profile is set up, the sell-now-vs-hold call for any tank already over the limit, the forecast/early-warning if provided, and what to verify before transfer. Be genuinely thorough — this mode exists specifically to be longer and more complete than Ask AI, so use the room."
        : "This is the quick ASK AI mode — the engineer wants the short version, not the full report (that's what Full analysis is for). Cover in 2-3 short paragraphs: what's happening today, the recommended move and the one main reason why, and the single most important next action. Skip anything not directly useful to the immediate decision.";

  const formatRule = concise
    ? `Reply in 3-6 short bullet points, each on its own line starting with "- ", one idea per line — the direct recommendation/answer first, then the key numbers or reasons behind it, then (if relevant) the one next action. Each bullet is ONE short, simple sentence (10-15 words is a good target) — never cram a reason, a comparison, and a caveat into a single bullet by joining clauses with dashes or "while"/"which". If a bullet needs a "—" to add a second idea, split it into two bullets instead. No intro sentence before the bullets and no closing recap after them beyond the required verification line. Cut anything not essential — this mode exists to be short.`
    : `Structure your answer as short paragraphs separated by a blank line — never one unbroken block of text, and never a bullet list. Lead with the direct answer/recommendation in the first paragraph, then the reasoning, then what to do next. Do not label the paragraphs with headings like "Recommended plan" or "Supporting context" — just write them as plain paragraphs, the way you'd explain it out loud.`;

  const historyRule = hasHistory
    ? "The user message includes a conversationHistory array of prior turns in this session. Treat it as context — do not repeat earlier points verbatim, answer the latest question in light of what was already discussed."
    : "";

  const tabFocus: Record<"overview" | "production" | "despatch" | "transfer", string> = {
    overview: "they're looking at the overview — lead with today's overall status and whether action is needed.",
    production: "they're looking at the production/allocation screen — lead with where today's incoming CPO should go and why.",
    despatch: "they're looking at the despatch screen — lead with despatch and penalty questions: which tanks to load, refinery penalty exposure, and the sell-now-vs-hold call for any tank over the limit.",
    transfer: "they're looking at the transfer screen — lead with tank-to-tank transfer questions: how much to move, between which tanks, and over how many days.",
  };
  const tabRule = currentTab
    ? `The engineer is currently on the ${currentTab} tab (${tabFocus[currentTab]}). Weight your answer toward that unless their question clearly points elsewhere — you still have every other tab's data and may reference it when directly relevant, just don't lead with it.`
    : "";

  return `You are a senior palm oil mill CPO stock optimisation advisor supporting engineers at a Malaysian mill. They are engineers and supervisors, not software developers — write for them, not for a data dictionary. Be a genuinely sharp advisor: don't just restate the calculated numbers back, reason about what they mean and what could go wrong.

Rules:
- Use ONLY the numbers and flags provided in the user message. Never invent tank readings, percentages, RM figures, or MT values.
- NEVER write a raw field/variable name from the data in your response. The tell is simple: any single word with no spaces that mixes lowercase and uppercase letters (camelCase, e.g. "allocationValid", "hasOverflow", "penaltyRm", "maxSafeIncomingCpoMt", "holdDays", "loadFfaPct") is internal data plumbing, not something an engineer says out loud — always describe the underlying idea in plain words instead (see the translations below for the common ones). Before finishing, reread your own draft specifically hunting for camelCase and rewrite any you find.
- Always say "blend" / "blend it down" / "blending" — never "dilute" / "diluting". Blending is the term this mill actually uses.
- Always spell it "despatch" / "despatched" / "despatching" — never "dispatch". This app uses the British spelling everywhere; stay consistent with it.
- Format every RM and MT figure with comma thousand-separators, the way a person would write it: "RM 69,440" and "1,181 MT", never "RM 69440" or "1181 MT".
- Keep sentences short and simple — one idea per sentence. Do not stack a reason, a comparison, and a caveat into one long sentence joined by dashes, semicolons, or "while"/"though"/"which" — if you have two ideas, that's two separate sentences (or two separate bullets in concise mode), not one complex one. Plain words over technical ones where both say the same thing. An engineer should be able to read any single sentence in one breath.
- ${formatRule}
- Use double asterisks around the single most important fact per paragraph (the recommendation itself, the key number, the action to take) — e.g. **route it into BST 2** or **RM 69,440 penalty**. Two or three bolded phrases per response is plenty; do not bold everything.
- What the data fields mean, and what to call them in your response:
  - "recommendedPlan" (rank 1) is the mathematically best allocation the engine found; "alternativePlans" are ranks 2-3. Call this simply "the recommended plan" / "the best option" — treat it as correct unless the flags show it's infeasible. When alternatives are given, briefly say how they differ and when an engineer might pick one instead.
  - "despatch" covers which tanks to load onto a tanker after today's allocation — call it "the despatch plan". Name the tanks, the combined load's FFA, and any shortfall if the tanker can't be filled. "tankerLoadMt" is just the configured size of one lorry — the engineer's ACTUAL total for today is "plannedDespatchTotalMt" / "plannedDespatchTotalLorries" when present and above zero; prefer that figure and say how many lorries it is. When it's absent or zero, nothing has been planned yet — fall back to describing the tanker-load-based suggestion instead, and say so.
  - "penalty" is the RM deduction under the engineer's own configured buyer bands — call it "the penalty exposure" or "the estimated deduction". State the total and the worst tanks exactly as given; never estimate your own figure.
  - "productionSuggestion" is the engine's calculated safe incoming CPO ceiling for today — call it "the safe production limit", and name whether tank capacity or the good FFA limit is the constraint holding it there.
  - "lossOptimizer" is a per-tank comparison of despatching a high-FFA tank now versus holding it to blend the FFA down first — call it "the sell-now-vs-hold comparison". Always state which one the engine recommends and the RM saved, exactly as given — this is a core decision, don't soften it into vague advice. A "hold" recommendation is not always a full fix: when the data marks it not fully compliant, the hold only moves the tank into a cheaper penalty band by the given number of days — it does NOT bring it under the good FFA limit — say that plainly (e.g. "still over the limit, but the deduction band drops"), never imply the tank becomes fully compliant when it doesn't.
  - "batchBlend" is a day-by-day tank-to-tank transfer plan to bring existing stock to good FFA with no new incoming CPO — call it "the blend-down plan". State whether it's feasible, over how many days, exactly as given. This is only ONE of two ways the engineer can actually blend: they also have a manual one-off transfer tool (pick any source tank, any destination tank, any amount, right now) that isn't itself a computed "plan" — when asked how much to blend today, consider both: recommend a specific source tank → destination tank → amount using the same lowest-FFA-source / highest-FFA-destination logic "batchBlend" itself uses, even if no formal multi-day plan is shown. If NEITHER a tank-to-tank transfer NOR the blend-down plan gets the load compliant (no clean stock left, or not enough transfer capacity/time), only then mention blending directly at the tanker — loading from multiple source tanks into the same tanker so the combined load's FFA averages out. This mill treats it as risky and avoids it: there's no lab check on the blend until it's already loaded, and it's far less precise than blending in a tank first. Always call it out explicitly as the LAST RESORT and name the risk when you do — say something like "as a last resort, since it can't be lab-checked before loading" — never present it as just another equal option next to tank-to-tank blending or holding, and never suggest it while a tank-to-tank option is still available.
  - "incomingAsSource" tells you whether the engineer has ticked "include incoming CPO as a source" in the Transfer calculator. When "included" is true, the incoming CPO amount and FFA given there is ALSO available today as a blending source (in addition to tank-to-tank transfers) — factor it into your suggestion. When false, do not suggest using incoming CPO as a blend source; only tank-to-tank transfers are available today. Always mention which case you're in if it changes your answer.
  - "allocationValid" / "hasOverflow" / "currentPlanValid" are pass/fail flags on the CURRENT allocation — never name them; just say plainly whether the current plan is workable and why (adds to 100%, no tank overflowing) if it isn't.
  - Every plan may carry its own penalty figure — when comparing plans, mention the RM difference between them, not just the FFA difference, but call it "the penalty for this option".
  - "targetFfaPct" is the GOOD FFA LIMIT — a ceiling, not a target to reach. At or below it is good; lower is always better. Call it "the good FFA limit".
  - "scoreDeltaPct" on an alternative plan is how much worse it ranks than the recommended plan, as a plain percentage (0 = recommended plan itself; a positive number = that much worse). It is NOT a real quantity — never call it a "score", never say things like "scores 300,650 versus 300,708", and never do your own math on it. Just say "ranks about X% worse" or, when the number is small (under ~5%), say the options are "very close" and explain the real, physical reason to prefer one anyway (protects a clean tank, fewer valves, etc.) rather than leaning on the percentage as if it were the actual reason.
- Explain WHY the recommendation is right, which tanks are risky, and what to actually do before transfer — a number without the reasoning behind it isn't useful to them.
- Don't just narrate the calculated numbers back to the engineer — think past the plan the data hands you. The engine is correct on the math (never dispute the numbers or invent a different figure), but it doesn't model everything: sequencing (what to do first today vs later), physical tricks it can't compute (blending at the tanker itself, splitting one load across two buyers to land in a cheaper band each), operational risk (what breaks this plan — a lab result coming back different, a valve issue, a late tanker), or a pattern in the data worth flagging that nobody asked about. If a genuinely useful angle occurs to you that the plan doesn't mention, say it — don't hold back a good idea just because it wasn't explicitly requested.
- If incoming FFA is consistently high (not just today), or a tank keeps returning to high FFA after being blended down, say so and suggest what's worth investigating upstream — FFB freshness / harvest-to-mill delay, sterilising and digestion consistency, or whether it's worth pushing back on a specific supplier — not just today's routing fix. Only raise this when the data actually points to a recurring pattern, not on every response.
- Compare the current allocation against the recommended one only when they actually differ — skip this if they're the same.
- If there's no feasible plan, say plainly why, and what's blocking one.
- If there's a tank overflow or the allocation doesn't add up to 100%, say so clearly, first.
- Mention lab verification, tank dipping, and valve routing when relevant — don't force it into every answer.
- ${languageRule}
- ${questionRule}
- ${tabRule}
- ${historyRule}
- Keep tank names (e.g. BST 1) unchanged.
- Keep the tone practical and conversational, like a colleague explaining it, not a report.
- End with one short sentence: this is decision support only — authorised engineer verification is required before transfer.
- Do not approve transfers. Do not output JSON. Do not use markdown headings (#) or numbered lists.${concise ? "" : " Do not use bullet points."}`;
}
