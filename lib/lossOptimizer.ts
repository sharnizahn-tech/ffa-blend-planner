// Loss optimiser: for a tank that is currently above the good FFA limit, work out
// whether it is cheaper to despatch it now (and take the refinery's penalty) or to
// hold it and blend the FFA down first — using whatever incoming daily CPO and/or
// lower-FFA tanks are actually available — then despatch at a lower (or zero)
// penalty.
//
// This exists because cherry-picking only the good-FFA tanks for despatch (and
// leaving high-FFA stock sitting) both grows the FFA-penalty exposure over time
// (the tank keeps ageing — see lib/prediction.ts) and never actually resolves the
// high-FFA stock. The engine below simulates day-by-day blending so the engineer
// gets a concrete number instead of a manual guess — including credit for a
// PARTIAL blend that only moves the tank into a cheaper penalty band, not just a
// full cure down to the limit.

import { calcPenaltyExposure, type PenaltyBand } from "./penalty";
import { estimateRisePerDay } from "./prediction";

export type LossTank = { name: string; capacity: number; stock: number; ffa: number };

/** One day's snapshot while simulating a hold — cumulative MT blended in by
 *  that day, so a caller can price a penalty at ANY day, not just the day
 *  the tank finally clears the limit. */
export type HoldDayPoint = {
  day: number;
  ffaPct: number;
  stockMt: number;
  incomingUsedMt: number;
  transferUsedMt: number;
};

export type HoldSimulation = {
  feasible: boolean;
  days: number | null;
  finalFfaPct: number;
  incomingUsedMt: number;
  transferUsedMt: number;
  trace: HoldDayPoint[];
};

export function simulateHoldToTarget(
  tank: LossTank,
  otherTanks: LossTank[],
  target: number,
  incomingCpoPerDayMt: number,
  incomingFfaPct: number,
  riseFactorPerDay: number,
  maxTransferPerDayMt: number,
  maxDays = 30,
  deadStockMt = 0,
): HoldSimulation {
  let stock = tank.stock;
  let ffa = tank.ffa;
  const trace: HoldDayPoint[] = [
    { day: 0, ffaPct: ffa, stockMt: stock, incomingUsedMt: 0, transferUsedMt: 0 },
  ];
  if (ffa <= target) {
    return { feasible: true, days: 0, finalFfaPct: ffa, incomingUsedMt: 0, transferUsedMt: 0, trace };
  }

  const sources = otherTanks
    .filter((t) => t.ffa < target)
    .map((t) => ({ ...t }))
    .sort((a, b) => a.ffa - b.ffa);

  let incomingUsed = 0;
  let transferUsed = 0;
  const ratePerDay = estimateRisePerDay(incomingFfaPct, riseFactorPerDay);

  for (let day = 1; day <= maxDays; day += 1) {
    ffa += ratePerDay;

    let spare = tank.capacity - stock;

    if (spare > 0.01 && incomingCpoPerDayMt > 0 && incomingFfaPct < ffa) {
      const moveMt = Math.min(incomingCpoPerDayMt, spare);
      const newStock = stock + moveMt;
      ffa = (stock * ffa + moveMt * incomingFfaPct) / newStock;
      stock = newStock;
      incomingUsed += moveMt;
      spare = tank.capacity - stock;
    }

    if (spare > 0.01 && sources.length && maxTransferPerDayMt > 0) {
      let budget = maxTransferPerDayMt;
      for (const src of sources) {
        if (budget <= 0 || spare <= 0.01) break;
        const moveMt = Math.min(budget, spare, Math.max(0, src.stock - deadStockMt));
        if (moveMt <= 0) continue;
        const newStock = stock + moveMt;
        ffa = (stock * ffa + moveMt * src.ffa) / newStock;
        stock = newStock;
        src.stock -= moveMt;
        transferUsed += moveMt;
        budget -= moveMt;
        spare = tank.capacity - stock;
      }
    }

    trace.push({ day, ffaPct: ffa, stockMt: stock, incomingUsedMt: incomingUsed, transferUsedMt: transferUsed });

    if (ffa <= target) {
      return { feasible: true, days: day, finalFfaPct: ffa, incomingUsedMt: incomingUsed, transferUsedMt: transferUsed, trace };
    }
  }

  return { feasible: false, days: null, finalFfaPct: ffa, incomingUsedMt: incomingUsed, transferUsedMt: transferUsed, trace };
}

export type HoldVsDespatch = {
  tankName: string;
  tankStockMt: number;
  tankFfaPct: number;
  despatchNowPenaltyRm: number;
  despatchNowRmPerMt: number;
  hold: HoldSimulation;
  holdPenaltyRm: number;
  savingsRm: number;
  recommendation: "hold" | "despatchNow";
  /** The cheapest day to despatch found anywhere in the hold trace — 0 means
   *  despatch now. This may land on a day the tank is STILL over the good
   *  FFA limit but has moved into a cheaper penalty band; it is not the same
   *  thing as `hold.days` (the day it becomes fully compliant), which can be
   *  null even when a genuinely cheaper partial hold exists. */
  bestDay: number;
  bestDayFfaPct: number;
  bestDayPenaltyRm: number;
  bestDayIncomingMt: number;
  bestDayTransferMt: number;
  bestDayFullyCompliant: boolean;
};

export function compareHoldVsDespatch(
  tank: LossTank,
  otherTanks: LossTank[],
  target: number,
  incomingCpoPerDayMt: number,
  incomingFfaPct: number,
  riseFactorPerDay: number,
  maxTransferPerDayMt: number,
  bands: PenaltyBand[],
  deadStockMt = 0,
): HoldVsDespatch {
  const despatchNowExposure = calcPenaltyExposure(tank.ffa, tank.stock, bands);
  const despatchNowPenaltyRm = despatchNowExposure.totalRm;
  const hold = simulateHoldToTarget(
    tank,
    otherTanks,
    target,
    incomingCpoPerDayMt,
    incomingFfaPct,
    riseFactorPerDay,
    maxTransferPerDayMt,
    30,
    deadStockMt,
  );

  // Walk the full day-by-day trace — not just whether the tank eventually
  // becomes fully compliant — so a hold that only moves the tank into a
  // CHEAPER penalty band (without curing it outright) still gets credit.
  // Day 0 (despatch now) always starts as the baseline, so "hold" only wins
  // when some later day is genuinely cheaper.
  let best = { ...hold.trace[0], penaltyRm: despatchNowPenaltyRm };
  for (const point of hold.trace) {
    const penaltyRm = calcPenaltyExposure(point.ffaPct, point.stockMt, bands).totalRm;
    if (penaltyRm < best.penaltyRm - 0.01) {
      best = { ...point, penaltyRm };
    }
  }

  const bestDay = best.day;
  const bestDayPenaltyRm = best.penaltyRm;
  const savingsRm = Math.max(0, despatchNowPenaltyRm - bestDayPenaltyRm);
  const recommendation: "hold" | "despatchNow" = bestDay > 0 && savingsRm > 0.01 ? "hold" : "despatchNow";

  return {
    tankName: tank.name,
    tankStockMt: tank.stock,
    tankFfaPct: tank.ffa,
    despatchNowPenaltyRm,
    despatchNowRmPerMt: despatchNowExposure.rmPerMt,
    hold,
    holdPenaltyRm: bestDayPenaltyRm,
    savingsRm,
    recommendation,
    bestDay,
    bestDayFfaPct: best.ffaPct,
    bestDayPenaltyRm,
    bestDayIncomingMt: best.incomingUsedMt,
    bestDayTransferMt: best.transferUsedMt,
    bestDayFullyCompliant: best.ffaPct <= target,
  };
}

const TRANSFER_RATE_KEY = "ffa-max-transfer-per-day-mt";
export const DEFAULT_MAX_TRANSFER_PER_DAY_MT = 200;

/** Auto-recommended max transfer rate when no real pump/valve spec is known:
 *  10% of the smallest involved tank's capacity per day is a common
 *  conservative rule of thumb for gravity/pump transfers between adjacent
 *  process tanks, clamped to a sane 50-300 MT/day operating range. This is
 *  an estimate to get started with, not a measured pump rate — replace it
 *  by typing your own number if you know your actual transfer capacity. */
export function autoMaxTransferPerDayMt(tanks: { capacity: number }[]): number {
  if (!tanks.length) return DEFAULT_MAX_TRANSFER_PER_DAY_MT;
  const minCapacity = Math.min(...tanks.map((t) => t.capacity));
  const raw = minCapacity * 0.1;
  const rounded = Math.round(raw / 10) * 10;
  return Math.min(300, Math.max(50, rounded));
}

export function loadMaxTransferPerDay(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(TRANSFER_RATE_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function saveMaxTransferPerDay(value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TRANSFER_RATE_KEY, String(value));
  } catch {
    // best-effort only
  }
}
