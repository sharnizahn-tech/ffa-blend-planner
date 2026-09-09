// "Blend at the tanker" — the last-resort move for a high-FFA tank that
// can't be cured in a storage tank first (no time, no spare capacity, or
// the Loss Optimizer already shows holding doesn't help): load some of its
// stock straight into the tanker together with clean stock from other
// tanks, so the COMBINED load's FFA averages out. This mill treats it as
// risky — there's no lab check on the blend until it's already loaded, far
// less precise than blending in a tank first — so it's only ever a
// fallback, and every suggestion here trades off how much of the problem
// tank gets cleared against how much safety margin is left under the limit.

export type TankerBlendTank = { name: string; stockMt: number; ffaPct: number };

export type TankerBlendSource = { name: string; mt: number; ffaPct: number };

export type TankerBlendOption = {
  /** "max" clears the most problem-tank stock (zero margin — landing right
   *  at the limit); "balanced" and "safest" trade some of that clearance
   *  for a buffer, since the blend can't be lab-verified before loading. */
  risk: "max" | "balanced" | "safest";
  problemTankMt: number;
  cleanSources: TankerBlendSource[];
  totalMt: number;
  combinedFfaPct: number;
  marginPct: number;
};

export type TankerBlendSuggestion = {
  problemTank: string;
  problemTankFfaPct: number;
  options: TankerBlendOption[];
};

type EvalResult = { combinedFfaPct: number; totalMt: number; sources: TankerBlendSource[] };

/** For a given amount of the problem tank's stock, greedily fills the rest
 *  of the tanker with clean stock (cleanest tank first) and reports the
 *  resulting combined FFA. */
function evalProblemAmount(
  problemMt: number,
  problemFfaPct: number,
  cleanPoolMt: { name: string; ffaPct: number; availableMt: number }[],
  tankerLoadMt: number,
): EvalResult {
  let budget = Math.max(0, tankerLoadMt - problemMt);
  let weighted = problemMt * problemFfaPct;
  let total = problemMt;
  const sources: TankerBlendSource[] = [];
  for (const c of cleanPoolMt) {
    if (budget <= 1e-9) break;
    if (c.availableMt <= 1e-9) continue;
    const take = Math.min(c.availableMt, budget);
    sources.push({ name: c.name, mt: take, ffaPct: c.ffaPct });
    weighted += take * c.ffaPct;
    total += take;
    budget -= take;
  }
  return { combinedFfaPct: total > 0 ? weighted / total : 0, totalMt: total, sources };
}

/** Binary search for the largest amount of the problem tank's stock that
 *  can go into the tanker while the combined load (topped up with clean
 *  stock, cleanest first) still lands at or under `effectiveTarget`. */
function solveMaxProblemMt(
  problemAvailableMt: number,
  problemFfaPct: number,
  cleanPoolMt: { name: string; ffaPct: number; availableMt: number }[],
  tankerLoadMt: number,
  effectiveTarget: number,
): EvalResult & { problemTankMt: number } {
  const upper = Math.min(problemAvailableMt, tankerLoadMt);
  if (upper <= 0) return { problemTankMt: 0, combinedFfaPct: 0, totalMt: 0, sources: [] };

  const atUpper = evalProblemAmount(upper, problemFfaPct, cleanPoolMt, tankerLoadMt);
  if (atUpper.combinedFfaPct <= effectiveTarget) {
    return { problemTankMt: upper, ...atUpper };
  }

  let lo = 0;
  let hi = upper;
  let best = evalProblemAmount(0, problemFfaPct, cleanPoolMt, tankerLoadMt);
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    const result = evalProblemAmount(mid, problemFfaPct, cleanPoolMt, tankerLoadMt);
    if (result.combinedFfaPct <= effectiveTarget) {
      lo = mid;
      best = result;
    } else {
      hi = mid;
    }
  }
  return { problemTankMt: lo, ...best };
}

/** Rounds a solved blend down to whole MT (never up — rounding down can
 *  only improve the margin, never break compliance) and recomputes the
 *  clean-source split for that rounded amount. */
function roundOption(
  risk: TankerBlendOption["risk"],
  problemFfaPct: number,
  cleanPoolMt: { name: string; ffaPct: number; availableMt: number }[],
  tankerLoadMt: number,
  target: number,
  raw: { problemTankMt: number },
): TankerBlendOption | null {
  const problemTankMt = Math.floor(raw.problemTankMt);
  if (problemTankMt < 1) return null;
  const result = evalProblemAmount(problemTankMt, problemFfaPct, cleanPoolMt, tankerLoadMt);
  const cleanSources = result.sources
    .map((s) => ({ ...s, mt: Math.floor(s.mt) }))
    .filter((s) => s.mt >= 1);
  if (!cleanSources.length) return null;
  const totalMt = problemTankMt + cleanSources.reduce((sum, s) => sum + s.mt, 0);
  const weighted =
    problemTankMt * problemFfaPct + cleanSources.reduce((sum, s) => sum + s.mt * s.ffaPct, 0);
  const combinedFfaPct = weighted / totalMt;
  return {
    risk,
    problemTankMt,
    cleanSources,
    totalMt,
    combinedFfaPct,
    marginPct: target - combinedFfaPct,
  };
}

/** Finds the worst tank currently over the good FFA limit and, if there's
 *  spare clean stock elsewhere, works out a handful of ranked ways to blend
 *  some of it away directly at the tanker — from the most aggressive
 *  (clears the most, zero safety margin) to the safest (clears less, but
 *  well clear of the limit). Returns null when there's no problem tank, or
 *  no clean stock anywhere to blend it with. */
export function suggestTankerBlend(
  tanks: TankerBlendTank[],
  target: number,
  tankerLoadMt: number,
  deadStockMt: number,
): TankerBlendSuggestion | null {
  if (tankerLoadMt <= 0) return null;

  const problem = tanks
    .filter((t) => t.ffaPct > target && t.stockMt - deadStockMt > 0.5)
    .sort((a, b) => b.ffaPct - a.ffaPct)[0];
  if (!problem) return null;

  const cleanPool = tanks
    .filter((t) => t !== problem && t.ffaPct <= target && t.stockMt - deadStockMt > 0.5)
    .sort((a, b) => a.ffaPct - b.ffaPct)
    .map((t) => ({ name: t.name, ffaPct: t.ffaPct, availableMt: t.stockMt - deadStockMt }));
  if (!cleanPool.length) return { problemTank: problem.name, problemTankFfaPct: problem.ffaPct, options: [] };

  const problemAvailableMt = problem.stockMt - deadStockMt;
  // Zero margin (right at the limit), then two safer tiers — each a real
  // percentage-point buffer, not a token gesture, since this is the blend
  // that can't be checked in a lab before the tanker leaves.
  const tiers: { risk: TankerBlendOption["risk"]; marginPct: number }[] = [
    { risk: "max", marginPct: 0 },
    { risk: "balanced", marginPct: 0.1 },
    { risk: "safest", marginPct: 0.2 },
  ];

  const options: TankerBlendOption[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    const effectiveTarget = target - tier.marginPct;
    if (effectiveTarget <= 0) continue;
    const raw = solveMaxProblemMt(problemAvailableMt, problem.ffaPct, cleanPool, tankerLoadMt, effectiveTarget);
    const option = roundOption(tier.risk, problem.ffaPct, cleanPool, tankerLoadMt, target, raw);
    if (!option) continue;
    const key = `${option.problemTankMt}:${option.cleanSources.map((s) => `${s.name}${s.mt}`).join(",")}`;
    if (seen.has(key)) continue; // a smaller margin tier can land on the same whole-MT numbers
    seen.add(key);
    options.push(option);
  }

  return { problemTank: problem.name, problemTankFfaPct: problem.ffaPct, options };
}
