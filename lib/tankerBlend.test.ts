import { describe, expect, it } from "vitest";
import { suggestTankerBlend } from "./tankerBlend";
import type { TankerBlendTank } from "./tankerBlend";

describe("suggestTankerBlend", () => {
  it("returns null when no tank is over the target", () => {
    const tanks: TankerBlendTank[] = [
      { name: "BST 1", stockMt: 500, ffaPct: 4.2 },
      { name: "BST 2", stockMt: 500, ffaPct: 4.5 },
    ];
    expect(suggestTankerBlend(tanks, 4.8, 40, 0)).toBeNull();
  });

  it("returns an empty options list when there's a problem tank but no clean stock to blend with", () => {
    const tanks: TankerBlendTank[] = [
      { name: "BST 1", stockMt: 500, ffaPct: 6.0 },
      { name: "BST 2", stockMt: 500, ffaPct: 5.5 },
    ];
    const result = suggestTankerBlend(tanks, 4.8, 40, 0);
    expect(result?.problemTank).toBe("BST 1"); // the worse of the two
    expect(result?.options).toEqual([]);
  });

  it("picks the worst-FFA tank as the problem tank and blends with the cleanest first", () => {
    const tanks: TankerBlendTank[] = [
      { name: "BST 1", stockMt: 1000, ffaPct: 4.2 },
      { name: "BST 2", stockMt: 1000, ffaPct: 7.0 },
    ];
    const result = suggestTankerBlend(tanks, 4.8, 40, 0);
    expect(result?.problemTank).toBe("BST 2");
    expect(result?.problemTankFfaPct).toBe(7.0);
    expect(result!.options.length).toBeGreaterThan(0);

    for (const option of result!.options) {
      // Every option must actually stay at or under the target it was solved for.
      expect(option.combinedFfaPct).toBeLessThanOrEqual(4.8 + 1e-6);
      expect(option.totalMt).toBeLessThanOrEqual(40);
      expect(option.cleanSources.every((s) => s.name === "BST 1")).toBe(true);
      // Weighted-average sanity check: recompute combinedFfaPct from the parts.
      const weighted =
        option.problemTankMt * 7.0 + option.cleanSources.reduce((s, c) => s + c.mt * c.ffaPct, 0);
      expect(option.combinedFfaPct).toBeCloseTo(weighted / option.totalMt, 5);
    }
  });

  it("orders risk tiers so max clears the most problem-tank stock and safest clears the least", () => {
    const tanks: TankerBlendTank[] = [
      { name: "BST 1", stockMt: 1000, ffaPct: 4.2 },
      { name: "BST 2", stockMt: 1000, ffaPct: 7.0 },
    ];
    const result = suggestTankerBlend(tanks, 4.8, 40, 0);
    const byRisk = Object.fromEntries(result!.options.map((o) => [o.risk, o]));
    if (byRisk.max && byRisk.balanced) {
      expect(byRisk.max.problemTankMt).toBeGreaterThanOrEqual(byRisk.balanced.problemTankMt);
    }
    if (byRisk.balanced && byRisk.safest) {
      expect(byRisk.balanced.problemTankMt).toBeGreaterThanOrEqual(byRisk.safest.problemTankMt);
    }
  });

  it("never returns more than 3 options and never a fractional MT amount", () => {
    const tanks: TankerBlendTank[] = [
      { name: "BST 1", stockMt: 1000, ffaPct: 4.2 },
      { name: "BST 2", stockMt: 1000, ffaPct: 7.0 },
    ];
    const result = suggestTankerBlend(tanks, 4.8, 40, 0);
    expect(result!.options.length).toBeLessThanOrEqual(3);
    for (const option of result!.options) {
      expect(Number.isInteger(option.problemTankMt)).toBe(true);
      for (const source of option.cleanSources) {
        expect(Number.isInteger(source.mt)).toBe(true);
      }
    }
  });

  it("respects the dead stock reserve when computing available clean/problem stock", () => {
    const tanks: TankerBlendTank[] = [
      { name: "BST 1", stockMt: 100, ffaPct: 4.2 }, // only 0 MT usable after a 100 MT reserve
      { name: "BST 2", stockMt: 1000, ffaPct: 7.0 },
    ];
    const result = suggestTankerBlend(tanks, 4.8, 40, 100);
    // BST 1 has nothing above the reserve, so there's no clean pool at all.
    expect(result?.options).toEqual([]);
  });

  it("returns null when the tanker load is zero or negative", () => {
    const tanks: TankerBlendTank[] = [
      { name: "BST 1", stockMt: 1000, ffaPct: 4.2 },
      { name: "BST 2", stockMt: 1000, ffaPct: 7.0 },
    ];
    expect(suggestTankerBlend(tanks, 4.8, 0, 0)).toBeNull();
  });
});
