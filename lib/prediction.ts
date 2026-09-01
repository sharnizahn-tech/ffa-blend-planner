// FFA rise-over-time projection.
//
// CPO's FFA keeps climbing the longer it sits in a tank (free fatty acids form
// from ongoing hydrolysis). How fast depends on the incoming CPO itself — fruit
// handling, bruising, moisture, time from harvest to mill — so instead of a fixed
// %/day constant, the rise rate here scales off the incoming CPO's own FFA
// reading via an editable multiplier the engineer tunes to match what they
// actually see in their tanks. Nothing about the true rate is invented; the
// multiplier defaults to a conservative starting point and is meant to be
// adjusted once compared against real dipping/lab results.

export const DEFAULT_RISE_FACTOR_PER_DAY = 0.02; // 2% of incoming FFA, per day of storage
export const DEFAULT_HORIZON_DAYS = 7;

export type FfaProjectionPoint = { day: number; ffaPct: number };

/** Estimated FFA rise per day for CPO from a given incoming batch (percentage points/day). */
export function estimateRisePerDay(incomingFfaPct: number, riseFactorPerDay: number): number {
  return Math.max(0, incomingFfaPct) * riseFactorPerDay;
}

export function projectFfaRise(
  startFfaPct: number,
  incomingFfaPct: number,
  riseFactorPerDay: number,
  days: number,
): FfaProjectionPoint[] {
  const ratePerDay = estimateRisePerDay(incomingFfaPct, riseFactorPerDay);
  const points: FfaProjectionPoint[] = [];
  for (let day = 0; day <= days; day += 1) {
    points.push({ day, ffaPct: startFfaPct + ratePerDay * day });
  }
  return points;
}

/** First day (0-indexed) the projection crosses the limit, or null if it stays within horizon. */
export function daysUntilLimit(
  startFfaPct: number,
  incomingFfaPct: number,
  riseFactorPerDay: number,
  limitPct: number,
  maxDays = DEFAULT_HORIZON_DAYS,
): number | null {
  if (startFfaPct > limitPct) return 0;
  const ratePerDay = estimateRisePerDay(incomingFfaPct, riseFactorPerDay);
  if (ratePerDay <= 0) return null;
  const daysExact = (limitPct - startFfaPct) / ratePerDay;
  if (daysExact > maxDays) return null;
  return Math.ceil(daysExact);
}

const RISE_FACTOR_KEY = "ffa-rise-factor-per-day";
const HORIZON_KEY = "ffa-rise-horizon-days";

export function loadRiseFactor(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(RISE_FACTOR_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function saveRiseFactor(value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RISE_FACTOR_KEY, String(value));
  } catch {
    // best-effort only
  }
}

export function loadHorizonDays(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(HORIZON_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function saveHorizonDays(value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HORIZON_KEY, String(value));
  } catch {
    // best-effort only
  }
}
