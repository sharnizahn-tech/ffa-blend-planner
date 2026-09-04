// Batch blend planner: for mills that don't run every day, work out how many days
// of tank-to-tank transfers (no new incoming CPO) it takes to bring existing BST
// stock down to the good FFA limit so it's dispatch-ready — e.g. "BST 1 is 4.5%,
// BST 2 is 5.8% — how much do I move, and how many days?"

export type BlendTank = { name: string; capacity: number; stock: number; ffa: number };

export type DailyTransferStep = {
  day: number;
  fromTank: string;
  toTank: string;
  mt: number;
  toTankFfaAfter: number;
};

export type BatchBlendResult = {
  feasible: boolean;
  days: number | null;
  steps: DailyTransferStep[];
  finalTanks: BlendTank[];
  reason:
    | "already-good"
    | "no-spare-capacity"
    | "no-low-ffa-source"
    | "source-exhausted"
    | "max-days-exceeded"
    | null;
};

export function planBatchBlend(
  tanks: BlendTank[],
  target: number,
  maxTransferPerDayMt: number,
  maxDays = 30,
  deadStockMt = 0,
): BatchBlendResult {
  const working = tanks.map((t) => ({ ...t }));

  if (working.every((t) => t.ffa <= target)) {
    return { feasible: true, days: 0, steps: [], finalTanks: working, reason: "already-good" };
  }

  const steps: DailyTransferStep[] = [];

  for (let day = 1; day <= maxDays; day += 1) {
    const high = working.filter((t) => t.ffa > target).sort((a, b) => b.ffa - a.ffa)[0];
    if (!high) {
      return { feasible: true, days: day - 1, steps, finalTanks: working, reason: null };
    }

    const spareNow = high.capacity - high.stock;
    if (spareNow <= 0.01) {
      return { feasible: false, days: null, steps, finalTanks: working, reason: "no-spare-capacity" };
    }

    // A source tank can only give up stock above its dead stock reserve —
    // the bottom layer is never drawn down, since quality degrades near empty.
    const sources = working
      .filter((t) => t !== high && t.ffa < target && t.stock - deadStockMt > 0)
      .sort((a, b) => a.ffa - b.ffa);
    if (!sources.length) {
      // Day 1 with nothing eligible means no low-FFA tank was ever available;
      // a later day means one WAS helping and has now been drawn down to its
      // dead stock reserve — a different, more useful thing to tell the
      // engineer than a flat "none available" (steps still hold the real
      // progress made before it ran dry).
      return {
        feasible: false,
        days: null,
        steps,
        finalTanks: working,
        reason: steps.length > 0 ? "source-exhausted" : "no-low-ffa-source",
      };
    }

    let budget = maxTransferPerDayMt;
    let movedToday = false;
    for (const src of sources) {
      if (budget <= 0) break;
      const spare = high.capacity - high.stock;
      if (spare <= 0.01) break;
      const moveMt = Math.min(budget, spare, Math.max(0, src.stock - deadStockMt));
      if (moveMt <= 0) continue;

      const newStock = high.stock + moveMt;
      const newFfa = (high.stock * high.ffa + moveMt * src.ffa) / newStock;
      steps.push({ day, fromTank: src.name, toTank: high.name, mt: moveMt, toTankFfaAfter: newFfa });

      src.stock -= moveMt;
      high.stock = newStock;
      high.ffa = newFfa;
      budget -= moveMt;
      movedToday = true;
    }

    if (!movedToday) {
      return {
        feasible: false,
        days: null,
        steps,
        finalTanks: working,
        reason: steps.length > 0 ? "source-exhausted" : "no-low-ffa-source",
      };
    }

    if (working.every((t) => t.ffa <= target)) {
      return { feasible: true, days: day, steps, finalTanks: working, reason: null };
    }
  }

  return { feasible: false, days: null, steps, finalTanks: working, reason: "max-days-exceeded" };
}
