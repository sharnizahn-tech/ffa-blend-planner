// Production optimisation: work backward from tank capacity + the good FFA limit
// to a safe amount of incoming CPO, then translate that into safe mill operating
// parameters (hours / utilisation) at the engineer's current settings.
//
// This is exact constraint math off the same mixing equation the rest of the app
// uses (tank.stock * tank.ffa + incoming * incomingFfa) / finalStock — nothing
// here is a guessed business rule.

export type ProductionTank = { name: string; capacity: number; stock: number; ffa: number };

export type SafeProductionSuggestion = {
  /** Max incoming CPO (MT) that can be blended without overflowing any tank or
   *  pushing any tank's final FFA above the limit, assuming the engine spreads
   *  it across tanks starting with the lowest-FFA spare capacity first. */
  maxSafeIncomingCpoMt: number;
  /** Max incoming CPO if only capacity (not FFA) were the constraint. */
  maxByCapacityOnlyMt: number;
  /** Which constraint is actually limiting how much CPO can safely come in. */
  binding: "capacity" | "ffa" | "none";
  /** Hours to cap operation at, holding today's utilisation % and OER fixed. */
  suggestedHoursAtCurrentUtilisation: number | null;
  /** Utilisation % to cap operation at, holding today's hours and OER fixed. */
  suggestedUtilisationPctAtCurrentHours: number | null;
};

export function suggestSafeProduction(
  tanks: ProductionTank[],
  target: number,
  incomingFfaPct: number,
  millCapacityMtHr: number,
  hours: number,
  utilisationPct: number,
  oerPct: number,
): SafeProductionSuggestion {
  let maxSafe = 0;
  let maxCapacityOnly = 0;

  for (const tank of tanks) {
    const spareCapacity = Math.max(0, tank.capacity - tank.stock);
    maxCapacityOnly += spareCapacity;

    let ffaCap = Infinity;
    if (incomingFfaPct > target) {
      if (tank.ffa >= target) {
        ffaCap = 0; // already at/above limit — don't recommend feeding more high-FFA CPO here
      } else {
        ffaCap = (tank.stock * (target - tank.ffa)) / (incomingFfaPct - target);
      }
    }
    maxSafe += Math.min(spareCapacity, ffaCap);
  }

  maxSafe = Math.max(0, maxSafe);
  const binding: SafeProductionSuggestion["binding"] =
    maxSafe <= 0 ? "none" : maxSafe < maxCapacityOnly - 0.5 ? "ffa" : "capacity";

  const rate = millCapacityMtHr * (oerPct / 100);
  const suggestedHoursAtCurrentUtilisation =
    rate > 0 && utilisationPct > 0 ? maxSafe / (rate * (utilisationPct / 100)) : null;
  const suggestedUtilisationPctAtCurrentHours =
    rate > 0 && hours > 0 ? (maxSafe / (rate * hours)) * 100 : null;

  return {
    maxSafeIncomingCpoMt: maxSafe,
    maxByCapacityOnlyMt: maxCapacityOnly,
    binding,
    suggestedHoursAtCurrentUtilisation,
    suggestedUtilisationPctAtCurrentHours,
  };
}

export type ProductionScenario = {
  id: string;
  label: string;
  millCapacityMtHr: number;
  hours: number;
  utilisationPct: number;
  oerPct: number;
  incomingFfaPct: number;
};

export function scenarioIncomingCpo(scenario: ProductionScenario): number {
  const ffb = (scenario.millCapacityMtHr * scenario.hours * scenario.utilisationPct) / 100;
  return (ffb * scenario.oerPct) / 100;
}
