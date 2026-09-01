// Refinery/buyer FFA penalty modelling.
//
// Different refineries apply different FFA price-deduction schedules — there is no
// single fixed rate. Instead of guessing numbers, the engineer defines one or more
// "buyer profiles" here (name + FFA bands + RM/MT deduction per band) and picks
// which one is active. All penalty math in the app runs against whatever the
// engineer has configured — nothing is hardcoded.

export type PenaltyBand = {
  id: string;
  /** Inclusive lower bound of this band, in FFA % (absolute, not relative to the limit). */
  minFfaPct: number;
  /** Inclusive upper bound, or null for open-ended (no ceiling). */
  maxFfaPct: number | null;
  /** Price deduction for CPO in this band, in RM per MT. */
  deductionRmPerMt: number;
};

export type BuyerProfile = {
  id: string;
  name: string;
  bands: PenaltyBand[];
};

export type PenaltyResult = {
  /** RM/MT deduction that applies at this FFA level (0 if below all bands). */
  rmPerMt: number;
  /** rmPerMt * tonnage. */
  totalRm: number;
  /** The band that matched, if any. */
  band: PenaltyBand | null;
};

let seedCounter = 0;
export function newPenaltyBandId() {
  seedCounter += 1;
  return `band-${Date.now()}-${seedCounter}`;
}

/** A single starter profile with no deductions configured yet — a template, not a guess. */
export function createEmptyBuyerProfile(name = "New buyer"): BuyerProfile {
  return {
    id: newPenaltyBandId(),
    name,
    bands: [],
  };
}

export function sortedBands(bands: PenaltyBand[]): PenaltyBand[] {
  return [...bands].sort((a, b) => a.minFfaPct - b.minFfaPct);
}

export function calcPenalty(ffaPct: number, bands: PenaltyBand[]): PenaltyResult {
  const match = sortedBands(bands).find(
    (b) => ffaPct >= b.minFfaPct && (b.maxFfaPct === null || ffaPct <= b.maxFfaPct),
  );
  return { rmPerMt: match?.deductionRmPerMt ?? 0, totalRm: 0, band: match ?? null };
}

export function calcPenaltyExposure(
  ffaPct: number,
  tonnageMt: number,
  bands: PenaltyBand[],
): PenaltyResult {
  const base = calcPenalty(ffaPct, bands);
  return { ...base, totalRm: base.rmPerMt * Math.max(0, tonnageMt) };
}

/** Total estimated RM exposure across a set of tank results (or despatch sources). */
export function calcTotalExposure(
  items: { ffaPct: number; tonnageMt: number }[],
  bands: PenaltyBand[],
): number {
  return items.reduce((sum, item) => sum + calcPenaltyExposure(item.ffaPct, item.tonnageMt, bands).totalRm, 0);
}

const STORAGE_KEY = "ffa-buyer-profiles";
const ACTIVE_KEY = "ffa-active-buyer-profile";

export function loadBuyerProfiles(): BuyerProfile[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BuyerProfile[];
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveBuyerProfiles(profiles: BuyerProfile[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // best-effort only
  }
}

export function loadActiveProfileId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveProfileId(id: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // best-effort only
  }
}
