import { describe, expect, it } from "vitest";
import { findTopDespatchPlans, planToDespatchPayload } from "./despatch";
import type { DespatchTank } from "./despatch";

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

  it("stays fast for a small number of tanks", () => {
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

  // Documents a real scalability limit rather than hiding it: the planner
  // brute-forces every whole-MT split of the tanker load across all tanks
  // (see buildDespatchPlan's `build` recursion in despatch.ts) — cost grows
  // combinatorially with BOTH tank count and load size, not just tank count.
  // Measured directly: 6 tanks with a 40 MT load enumerates roughly 1.2
  // million combinations and took ~3.5s on a dev machine. The app's own
  // schema allows up to 30 tanks, where this same function would need to
  // enumerate tens of millions of combinations per render — a real
  // timeout/hang risk on Vercel, not just a slow-in-theory concern. This
  // test is a regression guard, not a performance target: it should keep
  // passing until the algorithm is fixed, and if it ever gets dramatically
  // slower than this, something made the underlying problem worse.
  it("documents combinatorial cost at 6 tanks (regression guard, not a target)", () => {
    const tanks: DespatchTank[] = Array.from({ length: 6 }, (_, i) => ({
      name: `BST ${i + 1}`,
      stockMt: 500,
      ffaPct: 4.2 + i * 0.1,
    }));
    const start = performance.now();
    const plans = findTopDespatchPlans(tanks, 40, 4.8, 3, false);
    const elapsedMs = performance.now() - start;
    expect(plans.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(15000);
  }, 20000);
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
