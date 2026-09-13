import { describe, expect, it } from "vitest";
import { planBatchBlend } from "./batchBlend";
import type { BlendTank } from "./batchBlend";

describe("planBatchBlend", () => {
  it("reports already-good with 0 days when every tank is already within target", () => {
    const tanks: BlendTank[] = [{ name: "BST 1", capacity: 2000, stock: 500, ffa: 4.2 }];
    const result = planBatchBlend(tanks, 4.8, 10);
    expect(result).toMatchObject({ feasible: true, days: 0, reason: "already-good" });
  });

  it("blends the highest-FFA tank down using the lowest-FFA source available", () => {
    const tanks: BlendTank[] = [
      { name: "BST 1", capacity: 2000, stock: 500, ffa: 4.0 },
      { name: "BST 2", capacity: 2000, stock: 200, ffa: 6.5 },
    ];
    const result = planBatchBlend(tanks, 4.8, 50);
    expect(result.feasible).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0]).toMatchObject({ fromTank: "BST 1", toTank: "BST 2" });
    expect(result.finalTanks.every((t) => t.ffa <= 4.8)).toBe(true);
  });

  it("fails with no-low-ffa-source when every other tank is also over target", () => {
    const tanks: BlendTank[] = [
      { name: "BST 1", capacity: 2000, stock: 500, ffa: 6.0 },
      { name: "BST 2", capacity: 2000, stock: 500, ffa: 6.5 },
    ];
    const result = planBatchBlend(tanks, 4.8, 10);
    expect(result.feasible).toBe(false);
    expect(result.reason).toBe("no-low-ffa-source");
  });

  it("fails with no-spare-capacity when the high-FFA tank is already full", () => {
    const tanks: BlendTank[] = [
      { name: "BST 1", capacity: 2000, stock: 1000, ffa: 4.0 },
      { name: "BST 2", capacity: 500, stock: 500, ffa: 6.5 }, // full
    ];
    const result = planBatchBlend(tanks, 4.8, 10);
    expect(result.feasible).toBe(false);
    expect(result.reason).toBe("no-spare-capacity");
  });

  it("never draws a source tank below its dead stock reserve", () => {
    const tanks: BlendTank[] = [
      { name: "BST 1", capacity: 2000, stock: 110, ffa: 4.0 }, // only 10 MT usable above a 100 MT reserve
      { name: "BST 2", capacity: 2000, stock: 200, ffa: 6.5 },
    ];
    const result = planBatchBlend(tanks, 4.8, 50, 30, 100);
    const totalMoved = result.steps.reduce((s, step) => s + step.mt, 0);
    expect(totalMoved).toBeLessThanOrEqual(10 + 1e-6);
  });

  it("gives up with max-days-exceeded when the budget is too small to ever finish", () => {
    const tanks: BlendTank[] = [
      // Both tanks have plenty of spare capacity and the source has ample
      // stock, so the only thing standing in the way of finishing is the
      // tiny 1 MT/day transfer budget against a 100,000 MT high-FFA tank.
      { name: "BST 1", capacity: 200000, stock: 100000, ffa: 4.0 },
      { name: "BST 2", capacity: 200000, stock: 100000, ffa: 6.5 },
    ];
    const result = planBatchBlend(tanks, 4.8, 1, 3); // tiny transfer budget, only 3 days allowed
    expect(result.feasible).toBe(false);
    expect(result.reason).toBe("max-days-exceeded");
    expect(result.steps.length).toBe(3);
  });
});
