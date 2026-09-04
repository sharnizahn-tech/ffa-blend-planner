// Loss optimiser: for a tank that is currently above the good FFA limit, work out
// whether it is cheaper to despatch it now (and take the refinery's penalty) or to
// hold it and dilute the FFA down first — using whatever incoming daily CPO and/or
// lower-FFA tanks are actually available — then despatch penalty-free.
//
// This exists because cherry-picking only the good-FFA tanks for despatch (and
// leaving high-FFA stock sitting) both grows the FFA-penalty exposure over time
// (the tank keeps ageing — see lib/prediction.ts) and never actually resolves the
// high-FFA stock. The engine below simulates day-by-day dilution so the engineer
// gets a concrete number instead of a manual guess.

import { calcPenaltyExposure, type PenaltyBand } from "./penalty";
import { estimateRisePerDay } from "./prediction";

export type LossTank = { name: string; capacity: number; stock: number; ffa: number };

export type HoldSimulation = {
  feasible: boolean;
  days: number | null;
  finalFfaPct: number;
  incomingUsedMt: number;
  transferUsedMt: number;
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
  if (ffa <= target) {
    return { feasible: true, days: 0, finalFfaPct: ffa, incomingUsedMt: 0, transferUsedMt: 0 };
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

    if (ffa <= target) {
      return { feasible: true, days: day, finalFfaPct: ffa, incomingUsedMt: incomingUsed, transferUsedMt: transferUsed };
    }
  }

  return { feasible: false, days: null, finalFfaPct: ffa, incomingUsedMt: incomingUsed, transferUsedMt: transferUsed };
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
  // Only a *feasible* hold (tank actually reaches the good FFA limit in
  // time) can ever show savings. An infeasible hold must show zero savings
  // even if the simulation happened to end just above the limit but below
  // the buyer's lowest penalty band threshold — that band gap is real
  // (nothing charged there) but the tank is still non-compliant, so citing
  // "savings" would be presenting a number the plan never actually achieves.
  const holdPenaltyRm = hold.feasible ? 0 : despatchNowPenaltyRm;
  const savingsRm = hold.feasible ? Math.max(0, despatchNowPenaltyRm - holdPenaltyRm) : 0;
  const recommendation: "hold" | "despatchNow" =
    hold.feasible && savingsRm > 0 ? "hold" : "despatchNow";

  return {
    tankName: tank.name,
    tankStockMt: tank.stock,
    tankFfaPct: tank.ffa,
    despatchNowPenaltyRm,
    despatchNowRmPerMt: despatchNowExposure.rmPerMt,
    hold,
    holdPenaltyRm,
    savingsRm,
    recommendation,
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
