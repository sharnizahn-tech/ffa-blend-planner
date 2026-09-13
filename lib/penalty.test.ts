import { describe, expect, it } from "vitest";
import { calcPenalty, calcPenaltyExposure, calcTotalExposure, sortedBands } from "./penalty";
import type { PenaltyBand } from "./penalty";

const bands: PenaltyBand[] = [
  { id: "b2", minFfaPct: 5.51, maxFfaPct: 6, deductionRmPerMt: 60 },
  { id: "b1", minFfaPct: 4.81, maxFfaPct: 5, deductionRmPerMt: 20 },
  { id: "b3", minFfaPct: 6.01, maxFfaPct: null, deductionRmPerMt: 80 },
];

describe("sortedBands", () => {
  it("sorts by minFfaPct ascending without mutating the input", () => {
    const sorted = sortedBands(bands);
    expect(sorted.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    expect(bands.map((b) => b.id)).toEqual(["b2", "b1", "b3"]); // original untouched
  });
});

describe("calcPenalty", () => {
  it("returns zero deduction below every band", () => {
    const result = calcPenalty(4.5, bands);
    expect(result.rmPerMt).toBe(0);
    expect(result.band).toBeNull();
  });

  it("matches an inclusive lower bound", () => {
    expect(calcPenalty(4.81, bands).band?.id).toBe("b1");
  });

  it("matches an inclusive upper bound", () => {
    expect(calcPenalty(5.0, bands).band?.id).toBe("b1");
  });

  it("falls into the gap between bands as no match", () => {
    // 5.0 -> b1 upper bound; 5.51 -> b2 lower bound; 5.2 sits in the gap
    const result = calcPenalty(5.2, bands);
    expect(result.rmPerMt).toBe(0);
    expect(result.band).toBeNull();
  });

  it("matches an open-ended top band with no upper bound", () => {
    expect(calcPenalty(50, bands).band?.id).toBe("b3");
  });
});

describe("calcPenaltyExposure", () => {
  it("multiplies the matched rate by tonnage", () => {
    const result = calcPenaltyExposure(5.51, 100, bands);
    expect(result.rmPerMt).toBe(60);
    expect(result.totalRm).toBe(6000);
  });

  it("clamps negative tonnage to zero instead of a negative penalty", () => {
    const result = calcPenaltyExposure(5.51, -50, bands);
    expect(result.totalRm).toBe(0);
  });
});

describe("calcTotalExposure", () => {
  it("sums exposure across multiple tanks/sources independently", () => {
    const total = calcTotalExposure(
      [
        { ffaPct: 4.5, tonnageMt: 500 }, // below all bands -> 0
        { ffaPct: 4.9, tonnageMt: 100 }, // b1 -> 20/MT
        { ffaPct: 7.0, tonnageMt: 10 }, // b3 -> 80/MT
      ],
      bands,
    );
    expect(total).toBe(100 * 20 + 10 * 80);
  });

  it("returns 0 for an empty item list or empty bands", () => {
    expect(calcTotalExposure([], bands)).toBe(0);
    expect(calcTotalExposure([{ ffaPct: 10, tonnageMt: 100 }], [])).toBe(0);
  });
});
