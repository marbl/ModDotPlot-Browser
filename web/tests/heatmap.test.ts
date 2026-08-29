import { describe, expect, it } from "vitest";
import { addIdentitiesToHistogram, normalizeHeatmapRange } from "../src/heatmap";

describe("heatmap controls", () => {
  it("keeps minimum, midpoint, and maximum ordered", () => {
    expect(normalizeHeatmapRange({ minimum: 95, midpoint: 88, maximum: 99 }, "minimum"))
      .toEqual({ minimum: 95, midpoint: 95, maximum: 99 });
    expect(normalizeHeatmapRange({ minimum: 70, midpoint: 88, maximum: 80 }, "maximum"))
      .toEqual({ minimum: 80, midpoint: 80, maximum: 80 });
    expect(normalizeHeatmapRange({ minimum: 0, midpoint: 40, maximum: 120 }, "midpoint"))
      .toEqual({ minimum: 80, midpoint: 80, maximum: 100 });
  });

  it("ignores missing values and bins fixed-point identity", () => {
    const bins = new Uint32Array(101);
    addIdentitiesToHistogram(bins, new Uint16Array([7_001, 7_049, 9_999, 65_535]));
    expect(bins[70]).toBe(2);
    expect(bins[100]).toBe(1);
  });
});
