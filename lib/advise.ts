import { z } from "zod";

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
  recommendedPlan: z
    .object({
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
    })
    .nullable(),
  flags: z.object({
    allocationTotalPct: z.number(),
    allocationValid: z.boolean(),
    hasOverflow: z.boolean(),
    highFfaStockMt: z.number(),
    currentPlanValid: z.boolean(),
  }),
});

export type AdviseRequest = z.infer<typeof adviseRequestSchema>;

const n = (v: number, d = 1) =>
  v.toLocaleString("en-MY", { minimumFractionDigits: d, maximumFractionDigits: d });

export function buildOfflineOpinion(payload: AdviseRequest): string {
  const { production: p, flags, recommendedPlan, currentPlan, tanks } = payload;
  const highTanks = tanks.filter((t) => t.ffaPct > p.targetFfaPct).map((t) => t.name);
  const lines = [
    "Summary",
    `Expected incoming CPO is ${n(p.incomingCpoMt)} MT from ${n(p.estimatedFfbMt, 0)} MT FFB at ${n(p.incomingFfaPct, 2)}% FFA against a target of ${n(p.targetFfaPct, 2)}%.`,
  ];

  if (!flags.allocationValid) {
    lines.push(`Allocation is ${n(flags.allocationTotalPct, 0)}% — adjust to 100% before transfer.`);
  }
  if (flags.hasOverflow) {
    lines.push("At least one tank would overflow with the current allocation. Reduce percentages or free capacity first.");
  }
  if (flags.highFfaStockMt > 0) {
    lines.push(
      `Key risks: ${n(flags.highFfaStockMt, 0)} MT is already above target FFA${highTanks.length ? ` (${highTanks.join(", ")})` : ""}. Avoid feeding more high-FFA CPO into those tanks unless no safer capacity exists.`,
    );
  } else {
    lines.push("Key risks: no tank currently holds stock above the FFA target.");
  }

  lines.push("Recommended action");
  if (recommendedPlan) {
    const parts = recommendedPlan.tanks
      .filter((t) => t.allocationPct > 0)
      .map(
        (t) =>
          `${t.name}: ${t.allocationPct}% (${n(t.incomingMt)} MT → final FFA ${n(t.finalFfaPct, 2)}%)`,
      );
    lines.push(
      recommendedPlan.meetsTarget
        ? `Engine best plan keeps final FFA within target: ${parts.join("; ")}.`
        : `Engine best plan minimises quality impact: ${parts.join("; ")}.`,
    );
    const differs = currentPlan.some(
      (t, i) => t.allocationPct !== (recommendedPlan.allocationPct[i] ?? 0),
    );
    if (differs) {
      lines.push("Current manual allocation differs from the recommended plan — review before transfer.");
    }
  } else {
    lines.push("No feasible allocation fits available tank capacity with expected incoming CPO.");
  }

  lines.push(
    "Before transfer",
    "Verify latest dipping, laboratory FFA, available capacity, and valve routing. This offline summary is decision support only — authorised engineer verification is required before transfer.",
  );

  return lines.join("\n\n");
}

export const SYSTEM_PROMPT = `You are a senior palm oil mill CPO blending advisor supporting engineers at a Malaysian mill.

Rules:
- Use ONLY the numbers and flags provided in the user message. Never invent tank readings, percentages, or MT values.
- The recommendedPlan comes from a deterministic calculation engine. Treat it as the mathematical best plan unless flags show it is infeasible.
- Explain WHY the recommended allocation is best, which tanks are risky, and what operational actions the engineer should take before transfer.
- Compare currentPlan vs recommendedPlan when they differ.
- If recommendedPlan is null, explain why no feasible plan exists and what constraints block a solution.
- If hasOverflow is true or allocationValid is false, say so clearly first.
- Mention lab verification, dipping, valve routing, and despatch/hold options when relevant.
- Use short sections with plain headings: Summary, Key risks, Recommended action, Before transfer.
- Keep the tone professional, concise, and practical for shift engineers.
- End with one sentence: this is decision support only — authorised engineer verification is required before transfer.
- Do not approve transfers. Do not output JSON.`;
