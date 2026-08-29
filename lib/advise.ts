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

function bilingualSection(heading: string, en: string, ms: string) {
  return `${heading}\n\n${en}\n\n${ms}`;
}

export function buildOfflineOpinion(payload: AdviseRequest): string {
  const { production: p, flags, recommendedPlan, currentPlan, tanks } = payload;
  const highTanks = tanks.filter((t) => t.ffaPct > p.targetFfaPct).map((t) => t.name);
  const tankList = highTanks.length ? ` (${highTanks.join(", ")})` : "";
  const sections: string[] = [];

  sections.push(
    bilingualSection(
      "Summary / Ringkasan",
      `Expected incoming CPO is ${n(p.incomingCpoMt)} MT from ${n(p.estimatedFfbMt, 0)} MT FFB at ${n(p.incomingFfaPct, 2)}% FFA against a target of ${n(p.targetFfaPct, 2)}%.`,
      `CPO masuk dijangka ialah ${n(p.incomingCpoMt)} MT daripada ${n(p.estimatedFfbMt, 0)} MT TBS pada ${n(p.incomingFfaPct, 2)}% FFA berbanding sasaran ${n(p.targetFfaPct, 2)}%.`,
    ),
  );

  if (!flags.allocationValid) {
    sections.push(
      bilingualSection(
        "Allocation / Peruntukan",
        `Allocation is ${n(flags.allocationTotalPct, 0)}% — adjust to 100% before transfer.`,
        `Peruntukan ialah ${n(flags.allocationTotalPct, 0)}% — laraskan kepada 100% sebelum pemindahan.`,
      ),
    );
  }

  if (flags.hasOverflow) {
    sections.push(
      bilingualSection(
        "Capacity / Kapasiti",
        "At least one tank would overflow with the current allocation. Reduce percentages or free capacity first.",
        "Sekurang-kurangnya satu tangki akan melimpah dengan peruntukan semasa. Kurangkan peratusan atau kosongkan ruang tangki dahulu.",
      ),
    );
  }

  sections.push(
    bilingualSection(
      "Key risks / Risiko utama",
      flags.highFfaStockMt > 0
        ? `${n(flags.highFfaStockMt, 0)} MT is already above target FFA${tankList}. Avoid feeding more high-FFA CPO into those tanks unless no safer capacity exists.`
        : "No tank currently holds stock above the FFA target.",
      flags.highFfaStockMt > 0
        ? `${n(flags.highFfaStockMt, 0)} MT sudah melebihi sasaran FFA${tankList}. Elakkan memasukkan lebih banyak CPO FFA tinggi ke tangki tersebut melainkan tiada kapasiti yang lebih selamat.`
        : "Tiada tangki yang menyimpan stok melebihi sasaran FFA pada masa ini.",
    ),
  );

  if (recommendedPlan) {
    const parts = recommendedPlan.tanks
      .filter((t) => t.allocationPct > 0)
      .map(
        (t) =>
          `${t.name}: ${t.allocationPct}% (${n(t.incomingMt)} MT → final FFA ${n(t.finalFfaPct, 2)}%)`,
      );
    const planText = parts.join("; ");
    sections.push(
      bilingualSection(
        "Recommended action / Tindakan disyorkan",
        recommendedPlan.meetsTarget
          ? `Engine best plan keeps final FFA within target: ${planText}.`
          : `Engine best plan minimises quality impact: ${planText}.`,
        recommendedPlan.meetsTarget
          ? `Pelan terbaik enjin mengekalkan FFA akhir dalam sasaran: ${planText}.`
          : `Pelan terbaik enjin meminimumkan kesan kualiti: ${planText}.`,
      ),
    );

    const differs = currentPlan.some(
      (t, i) => t.allocationPct !== (recommendedPlan.allocationPct[i] ?? 0),
    );
    if (differs) {
      sections.push(
        bilingualSection(
          "Manual vs recommended / Manual vs disyorkan",
          "Current manual allocation differs from the recommended plan — review before transfer.",
          "Peruntukan manual semasa berbeza daripada pelan disyorkan — semak sebelum pemindahan.",
        ),
      );
    }
  } else {
    sections.push(
      bilingualSection(
        "Recommended action / Tindakan disyorkan",
        "No feasible allocation fits available tank capacity with expected incoming CPO.",
        "Tiada peruntukan yang munasabah muat dalam kapasiti tangki available dengan CPO masuk dijangka.",
      ),
    );
  }

  sections.push(
    bilingualSection(
      "Before transfer / Sebelum pemindahan",
      "Verify latest dipping, laboratory FFA, available capacity, and valve routing. This offline summary is decision support only — authorised engineer verification is required before transfer.",
      "Sahkan dipping tangki terkini, FFA makmal, kapasiti available, dan laluan injap. Ringkasan luar talian ini ialah sokongan keputusan sahaja — pengesahan jurutera berwibawa diperlukan sebelum pemindahan.",
    ),
  );

  return sections.join("\n\n");
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
- Write EVERY section in BOTH English and Bahasa Melayu. Use bilingual headings like "Summary / Ringkasan", "Key risks / Risiko utama", "Recommended action / Tindakan disyorkan", "Before transfer / Sebelum pemindahan".
- Under each heading: first the English paragraph, then a blank line, then the Bahasa Melayu paragraph. Keep tank names (e.g. BST 1) unchanged in both languages.
- Use natural Malaysian mill terminology in Malay (TBS, tangki, FFA, CPO, dipping, injap).
- Keep the tone professional, concise, and practical for shift engineers.
- End with one bilingual disclaimer sentence (English then Malay): decision support only — authorised engineer verification is required before transfer.
- Do not approve transfers. Do not output JSON.`;
