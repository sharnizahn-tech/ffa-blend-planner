import { describe, expect, it } from "vitest";
import { scenarioIncomingCpo, suggestSafeProduction } from "./production";
import type { ProductionTank } from "./production";

describe("suggestSafeProduction", () => {
  it("is capacity-bound when incoming FFA is already within the good limit", () => {
    const tanks: ProductionTank[] = [{ name: "BST 1", capacity: 1000, stock: 900, ffa: 4.2 }];
    const result = suggestSafeProduction(tanks, 4.8, 4.5, 40, 20, 100, 19);
    expect(result.binding).toBe("capacity");
    expect(result.maxSafeIncomingCpoMt).toBe(100); // only 100 MT of spare capacity
  });

  it("is FFA-bound when incoming CPO is dirtier than the target and would push a clean tank over", () => {
    const tanks: ProductionTank[] = [{ name: "BST 1", capacity: 10000, stock: 100, ffa: 4.0 }];
    // Huge spare capacity, but incoming FFA (9%) is well above target (4.8%) -
    // the FFA constraint should bind long before the tank fills up.
    const result = suggestSafeProduction(tanks, 4.8, 9.0, 40, 20, 100, 19);
    expect(result.binding).toBe("ffa");
    expect(result.maxSafeIncomingCpoMt).toBeLessThan(result.maxByCapacityOnlyMt);
  });

  it("allows zero more into a tank already at or above the target when incoming is dirty", () => {
    const tanks: ProductionTank[] = [{ name: "BST 2", capacity: 2000, stock: 500, ffa: 6.0 }];
    const result = suggestSafeProduction(tanks, 4.8, 9.0, 40, 20, 100, 19);
    expect(result.maxSafeIncomingCpoMt).toBe(0);
    expect(result.binding).toBe("none");
  });

  it("returns null suggested hours/utilisation when the mill rate is zero", () => {
    const tanks: ProductionTank[] = [{ name: "BST 1", capacity: 1000, stock: 0, ffa: 4.0 }];
    const result = suggestSafeProduction(tanks, 4.8, 4.5, 0, 20, 100, 19);
    expect(result.suggestedHoursAtCurrentUtilisation).toBeNull();
    expect(result.suggestedUtilisationPctAtCurrentHours).toBeNull();
  });
});

describe("scenarioIncomingCpo", () => {
  it("computes FFB then CPO via mill rate * hours * utilisation * OER", () => {
    const cpo = scenarioIncomingCpo({
      id: "a",
      label: "A",
      millCapacityMtHr: 50,
      hours: 20,
      utilisationPct: 90,
      oerPct: 20,
      incomingFfaPct: 5,
    });
    // FFB = 50 * 20 * 0.9 = 900; CPO = 900 * 0.2 = 180
    expect(cpo).toBe(180);
  });
});
