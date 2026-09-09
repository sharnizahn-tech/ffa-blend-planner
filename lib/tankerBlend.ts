// "Blend at the tanker" — for a high-FFA tank that can't be cured in a
// storage tank first (the Loss Optimizer already shows holding doesn't
// help), work out exactly how much of it to load straight into the tanker
// together with clean stock from another tank, so the COMBINED load's FFA
// averages back under the limit. The system decides one definite answer —
// not a menu of options — but keeps a small safety margin below the limit
// by default, since this blend can't be lab-checked until it's already
// loaded, so it's less precise than blending in a tank first.

export type TankerBlendTank = { name: string; stockMt: number; ffaPct: number };

export type TankerBlendSource = { name: string; mt: number; ffaPct: number };

export type TankerBlendOption = {
  problemTankMt: number;
  cleanSources: TankerBlendSource[];
  totalMt: number;
  combinedFfaPct: number;
  marginPct: number;
};

export type TankerBlendSuggestion = {
  problemTank: string;
  problemTankFfaPct: number;
  option: TankerBlendOption | null;
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
    problemTankMt,
    cleanSources,
    totalMt,
    combinedFfaPct,
    marginPct: target - combinedFfaPct,
  };
}

/** Finds the worst tank currently over the good FFA limit and, if there's
 *  spare clean stock elsewhere, decides one definite way to blend some of
 *  it away directly at the tanker. Prefers a real safety margin (0.1 point
 *  under the limit) since the blend can't be lab-checked before the tanker
 *  leaves; falls back to the maximum feasible amount (landing right at the
 *  limit) only if that safer margin can't clear a meaningful amount at all.
 *  Returns null when there's no problem tank, or no clean stock anywhere to
 *  blend it with. */
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
  if (!cleanPool.length) return { problemTank: problem.name, problemTankFfaPct: problem.ffaPct, option: null };

  const problemAvailableMt = problem.stockMt - deadStockMt;
  // Try the safer margin first; only drop to zero margin (right at the
  // limit) if that safer blend can't clear a meaningful amount at all.
  const margins = [0.1, 0];
  for (const marginPct of margins) {
    const effectiveTarget = target - marginPct;
    if (effectiveTarget <= 0) continue;
    const raw = solveMaxProblemMt(problemAvailableMt, problem.ffaPct, cleanPool, tankerLoadMt, effectiveTarget);
    const option = roundOption(problem.ffaPct, cleanPool, tankerLoadMt, target, raw);
    if (option) return { problemTank: problem.name, problemTankFfaPct: problem.ffaPct, option };
  }

  return { problemTank: problem.name, problemTankFfaPct: problem.ffaPct, option: null };
}
