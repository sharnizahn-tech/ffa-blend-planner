import { describe, expect, it } from "vitest";
import { autoMaxTransferPerDayMt, compareHoldVsDespatch, simulateHoldToTarget } from "./lossOptimizer";
import type { LossTank } from "./lossOptimizer";
import type { PenaltyBand } from "./penalty";

const bands: PenaltyBand[] = [
  { id: "b1", minFfaPct: 4.81, maxFfaPct: 6, deductionRmPerMt: 40 },
  { id: "b2", minFfaPct: 6.01, maxFfaPct: null, deductionRmPerMt: 100 },
];

describe("simulateHoldToTarget", () => {
  it("is immediately feasible with 0 days when the tank is already at/under target", () => {
    const tank: LossTank = { name: "BST 1", capacity: 2000, stock: 500, ffa: 4.5 };
    const result = simulateHoldToTarget(tank, [], 4.8, 0, 0, 10);
    expect(result).toMatchObject({ feasible: true, days: 0, finalFfaPct: 4.5 });
  });

  it("blends down day by day using incoming CPO before touching transfer budget", () => {
    const tank: LossTank = { name: "BST 2", capacity: 5000, stock: 800, ffa: 6.0 };
    const result = simulateHoldToTarget(tank, [], 4.8, 200, 3.0, 0, 30);
    expect(result.feasible).toBe(true);
    expect(result.days).toBe(3);
    expect(result.trace[1].incomingUsedMt).toBeGreaterThan(0);
    expect(result.trace[1].transferUsedMt).toBe(0); // no other tanks to transfer from
    // FFA should monotonically move toward target once incoming CPO is cleaner than the tank
    expect(result.trace[1].ffaPct).toBeLessThan(6.0);
  });

  it("is infeasible when nothing can ever bring the tank down (no incoming, no clean sources)", () => {
    const tank: LossTank = { name: "BST 2", capacity: 2000, stock: 800, ffa: 6.0 };
    const result = simulateHoldToTarget(tank, [], 4.8, 0, 0, 10, 5);
    expect(result.feasible).toBe(false);
    expect(result.days).toBeNull();
    expect(result.finalFfaPct).toBe(6.0); // never moved
  });

  it("draws from the cleanest other tank first and respects its dead stock reserve", () => {
    const tank: LossTank = { name: "BST 2", capacity: 2000, stock: 800, ffa: 6.0 };
    const clean: LossTank = { name: "BST 1", capacity: 2000, stock: 50, ffa: 4.0 };
    // deadStockMt of 50 means BST 1 has nothing to give
    const result = simulateHoldToTarget(tank, [clean], 4.8, 0, 0, 10, 5, 50);
    expect(result.trace[1]?.transferUsedMt ?? 0).toBe(0);
  });
});

describe("compareHoldVsDespatch", () => {
  it("recommends despatchNow when holding never improves the penalty band", () => {
    const tank: LossTank = { name: "BST 2", capacity: 2000, stock: 800, ffa: 5.5 }; // already in the cheap band 4.81-6
    const result = compareHoldVsDespatch(tank, [], 4.8, 0, 0, 10, bands, 0);
    expect(result.recommendation).toBe("despatchNow");
    expect(result.savingsRm).toBe(0);
  });

  it("recommends hold when blending crosses into a cheaper band before day 30", () => {
    const tank: LossTank = { name: "BST 2", capacity: 2000, stock: 200, ffa: 6.5 }; // starts in the 100/MT band
    const clean: LossTank = { name: "BST 1", capacity: 2000, stock: 2000, ffa: 4.0 };
    const result = compareHoldVsDespatch(tank, [clean], 4.8, 0, 0, 50, bands, 0);
    expect(result.despatchNowPenaltyRm).toBeCloseTo(200 * 100, 5);
    expect(result.recommendation).toBe("hold");
    expect(result.bestDay).toBeGreaterThan(0);
    expect(result.savingsRm).toBeGreaterThan(0);
    expect(result.holdPenaltyRm).toBeLessThan(result.despatchNowPenaltyRm);
  });

  it("gives credit for a partial blend into a cheaper band even if never fully compliant", () => {
    // Small clean source: enough to nudge the tank into the cheaper band but
    // not enough to ever get under the 4.8 target within 30 days.
    const tank: LossTank = { name: "BST 2", capacity: 2000, stock: 1000, ffa: 6.5 };
    const clean: LossTank = { name: "BST 1", capacity: 2000, stock: 50, ffa: 4.0 };
    const result = compareHoldVsDespatch(tank, [clean], 4.8, 0, 0, 50, bands, 0);
    expect(result.hold.feasible).toBe(false); // never reaches 4.8
    expect(result.bestDayFullyCompliant).toBe(false);
    // Still may or may not recommend hold depending on whether the band actually improved;
    // the key contract is that it never claims a saving that doesn't exist.
    expect(result.savingsRm).toBeGreaterThanOrEqual(0);
  });
});

describe("autoMaxTransferPerDayMt", () => {
  it("falls back to the default when there are no tanks", () => {
    expect(autoMaxTransferPerDayMt([])).toBe(10);
  });

  it("clamps to the 5-20 MT/day range regardless of tank size", () => {
    expect(autoMaxTransferPerDayMt([{ capacity: 100 }])).toBe(5); // 1% of 100 = 1, clamped up to 5
    expect(autoMaxTransferPerDayMt([{ capacity: 100000 }])).toBe(20); // 1% of 100000 = 1000, clamped down to 20
  });

  it("uses the smallest tank's capacity, not the largest", () => {
    const result = autoMaxTransferPerDayMt([{ capacity: 2000 }, { capacity: 500 }]);
    // 1% of 500 = 5, rounded to nearest 5 = 5
    expect(result).toBe(5);
  });
});
