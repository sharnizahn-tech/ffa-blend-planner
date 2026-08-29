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
