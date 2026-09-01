export type DespatchTank = { name: string; stockMt: number; ffaPct: number };

export type DespatchSource = {
  name: string;
  mt: number;
  ffaPct: number;
};

export type DespatchPlan = {
  sources: DespatchSource[];
  totalMt: number;
  loadFfaPct: number;
  meetsLimit: boolean;
  score: number;
  shortfallMt: number;
};

function sameSources(a: DespatchSource[], b: DespatchSource[]) {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.name === b[i].name && s.mt === b[i].mt);
}

/** Weight applied to the number of source tanks a plan draws from. Higher =
 *  more strongly prefers simpler loads (fewer tanks) when the FFA outcome is
 *  similar — easier for the loading crew to execute. */
const TANK_COUNT_WEIGHT_DEFAULT = 5;
const TANK_COUNT_WEIGHT_PREFER_FEWER = 30;

function buildDespatchPlan(
  sources: DespatchSource[],
  loadMt: number,
  target: number,
  tankCountWeight: number,
): DespatchPlan {
  const active = sources.filter((s) => s.mt > 0);
  const totalMt = active.reduce((s, x) => s + x.mt, 0);
  const loadFfaPct =
    totalMt > 0 ? active.reduce((s, x) => s + x.mt * x.ffaPct, 0) / totalMt : 0;
  const shortfallMt = Math.max(0, loadMt - totalMt);
  const excess = Math.max(0, loadFfaPct - target) * totalMt;
  const score =
    excess * 100 + shortfallMt * 50 + active.length * tankCountWeight + loadFfaPct * 0.1;
  return {
    sources: active,
    totalMt,
    loadFfaPct,
    meetsLimit: totalMt > 0 && loadFfaPct <= target,
    score,
    shortfallMt,
  };
}

export function findTopDespatchPlans(
  tanks: DespatchTank[],
  loadMt: number,
  target: number,
  limit = 3,
  preferFewerTanks = true,
): DespatchPlan[] {
  if (loadMt <= 0 || tanks.length === 0) return [];

  const tankCountWeight = preferFewerTanks
    ? TANK_COUNT_WEIGHT_PREFER_FEWER
    : TANK_COUNT_WEIGHT_DEFAULT;
  const top: DespatchPlan[] = [];
  const totalAvailable = tanks.reduce((s, t) => s + Math.max(0, t.stockMt), 0);
  if (totalAvailable <= 0) return [];

  const targetFill = Math.min(loadMt, totalAvailable);

  const assess = (amounts: number[]) => {
    const sources = tanks.map((t, i) => ({
      name: t.name,
      mt: amounts[i] ?? 0,
      ffaPct: t.ffaPct,
    }));
    const plan = buildDespatchPlan(sources, loadMt, target, tankCountWeight);
    if (plan.totalMt <= 0) return;
    if (top.some((p) => sameSources(p.sources, plan.sources))) return;
    top.push(plan);
    top.sort((a, b) => a.score - b.score);
    if (top.length > limit) top.length = limit;
  };

  const build = (index: number, remaining: number, values: number[]) => {
    if (index === tanks.length - 1) {
      const last = Math.min(tanks[index].stockMt, remaining);
      if (last === remaining) assess([...values, last]);
      return;
    }
    const max = Math.min(tanks[index].stockMt, remaining);
    for (let value = 0; value <= max; value += 1) {
      build(index + 1, remaining - value, [...values, value]);
    }
  };

  build(0, targetFill, []);
  return top;
}

export function planToDespatchPayload(plan: DespatchPlan, rank: number) {
  return {
    rank,
    totalMt: plan.totalMt,
    loadFfaPct: plan.loadFfaPct,
    meetsTarget: plan.meetsLimit,
    shortfallMt: plan.shortfallMt,
    score: plan.score,
    sources: plan.sources.map((s) => ({
      name: s.name,
      mt: s.mt,
      ffaPct: s.ffaPct,
    })),
  };
}
