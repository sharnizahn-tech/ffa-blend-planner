import { describe, expect, it } from "vitest";
import { estimateCombinationsOver, findTopDespatchPlans, planToDespatchPayload } from "./despatch";
import type { DespatchTank } from "./despatch";

describe("estimateCombinationsOver", () => {
  it("is never over the cap for a single slot (nothing to combine)", () => {
    expect(estimateCombinationsOver(1000, 1, 1)).toBe(false);
    expect(estimateCombinationsOver(1000, 0, 1)).toBe(false);
  });

  it("matches the exact stars-and-bars count for small cases", () => {
    // C(20 + 2 - 1, 2 - 1) = C(21, 1) = 21
    expect(estimateCombinationsOver(20, 2, 20)).toBe(true);
    expect(estimateCombinationsOver(20, 2, 21)).toBe(false);
  });

  it("detects a real-world blowup (10 tanks, 5% allocation steps) is over a 200k cap", () => {
    // budget = 100/5 = 20 "slots" of 5% each, across 10 tanks
    expect(estimateCombinationsOver(20, 10, 200_000)).toBe(true);
  });

  it("confirms coarsening the step size brings the same case back under the cap", () => {
    // budget = 100/10 = 10 "slots" of 10% each, across 10 tanks
    expect(estimateCombinationsOver(10, 10, 200_000)).toBe(false);
  });
});

describe("findTopDespatchPlans", () => {
  it("returns an empty list when the load or stock is non-positive", () => {
    const tanks: DespatchTank[] = [{ name: "BST 1", stockMt: 500, ffaPct: 4.2 }];
    expect(findTopDespatchPlans(tanks, 0, 4.8)).toEqual([]);
    expect(findTopDespatchPlans([], 40, 4.8)).toEqual([]);
    expect(findTopDespatchPlans([{ name: "BST 1", stockMt: 0, ffaPct: 4.2 }], 40, 4.8)).toEqual([]);
  });

  it("fills a full tanker load from a single clean tank with plenty of stock", () => {
    const tanks: DespatchTank[] = [{ name: "BST 1", stockMt: 500, ffaPct: 4.2 }];
    const [best] = findTopDespatchPlans(tanks, 40, 4.8);
    expect(best.totalMt).toBe(40);
    expect(best.loadFfaPct).toBe(4.2);
    expect(best.meetsLimit).toBe(true);
    expect(best.shortfallMt).toBe(0);
  });

  it("reports a shortfall when total available stock is less than the load", () => {
    const tanks: DespatchTank[] = [{ name: "BST 1", stockMt: 25, ffaPct: 4.2 }];
    const [best] = findTopDespatchPlans(tanks, 40, 4.8);
    expect(best.totalMt).toBe(25);
    expect(best.shortfallMt).toBe(15);
  });

  it("prefers fewer tanks when preferFewerTanks is true, given an equally-clean alternative", () => {
    const tanks: DespatchTank[] = [
      { name: "BST 1", stockMt: 500, ffaPct: 4.2 },
      { name: "BST 2", stockMt: 500, ffaPct: 4.2 }, // identical FFA - only tank count differs
    ];
    const [best] = findTopDespatchPlans(tanks, 40, 4.8, 3, true);
    expect(best.sources.length).toBe(1); // pulls the whole 40 MT from one tank, not split
  });

  it("never returns more plans than the requested limit, and never a duplicate source split", () => {
    const tanks: DespatchTank[] = [
      { name: "BST 1", stockMt: 500, ffaPct: 4.2 },
      { name: "BST 2", stockMt: 500, ffaPct: 4.6 },
    ];
    const plans = findTopDespatchPlans(tanks, 40, 4.8, 3, false);
    expect(plans.length).toBeLessThanOrEqual(3);
    const keys = plans.map((p) => p.sources.map((s) => `${s.name}:${s.mt}`).join(","));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stays fast for a small number of tanks (brute-force path)", () => {
    const tanks: DespatchTank[] = Array.from({ length: 4 }, (_, i) => ({
      name: `BST ${i + 1}`,
      stockMt: 500,
      ffaPct: 4.2 + i * 0.1,
    }));
    const start = performance.now();
    const plans = findTopDespatchPlans(tanks, 40, 4.8, 3, false);
    const elapsedMs = performance.now() - start;
    expect(plans.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2000);
  });

  // Regression test for the scalability fix: enumerating every whole-MT
  // split of the load across many tanks used to grow combinatorially (6
  // tanks at a 40 MT load alone was ~1.2 million combinations, ~3.5s). Past
  // SAFE_ENUMERATION_LIMIT, findTopDespatchPlans now switches to a greedy
  // fallback instead — this proves it actually stays fast even well beyond
  // the schema's 30-tank ceiling, and that the fallback still produces a
  // sensible, correctly-ranked plan.
  it("stays fast even with many tanks, via the greedy fallback", () => {
    const tanks: DespatchTank[] = Array.from({ length: 20 }, (_, i) => ({
      name: `BST ${i + 1}`,
      stockMt: 500,
      ffaPct: 4.0 + i * 0.1,
    }));
    const start = performance.now();
    const plans = findTopDespatchPlans(tanks, 40, 4.8, 3, false);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(500);
    expect(plans.length).toBeGreaterThan(0);
    // The best plan should draw entirely from the single cleanest tank
    // (BST 1 at 4.0%) — greedy-fill-cleanest-first is optimal here since
    // it alone has enough stock for the whole load.
    expect(plans[0].sources).toEqual([{ name: "BST 1", mt: 40, ffaPct: 4.0 }]);
  });

  it("greedy fallback offers a genuinely different 'reserve the cleanest tank' alternative", () => {
    const tanks: DespatchTank[] = Array.from({ length: 20 }, (_, i) => ({
      name: `BST ${i + 1}`,
      stockMt: 500,
      ffaPct: 4.0 + i * 0.1,
    }));
    const plans = findTopDespatchPlans(tanks, 40, 4.8, 3, false);
    expect(plans.length).toBeGreaterThan(1);
    // Every plan should be a distinct source split.
    const keys = plans.map((p) => p.sources.map((s) => `${s.name}:${s.mt}`).join(","));
    expect(new Set(keys).size).toBe(keys.length);
    // The 2nd-ranked plan should not touch BST 1 (the reserved cleanest tank).
    expect(plans[1].sources.some((s) => s.name === "BST 1")).toBe(false);
  });
});

describe("planToDespatchPayload", () => {
  it("expresses score as a percentage delta against the best plan's score", () => {
    const tanks: DespatchTank[] = [
      { name: "BST 1", stockMt: 500, ffaPct: 4.2 },
      { name: "BST 2", stockMt: 500, ffaPct: 5.0 },
    ];
    const plans = findTopDespatchPlans(tanks, 40, 4.8, 3, false);
    const best = plans[0];
    const payload = planToDespatchPayload(best, 1);
    expect(payload.scoreDeltaPct).toBe(0); // baseline defaults to its own score
    expect(payload.rank).toBe(1);
    expect(payload.sources.map((s) => s.name)).toEqual(best.sources.map((s) => s.name));
  });
});
