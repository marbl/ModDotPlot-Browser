import { describe, expect, it } from "vitest";
import {
  addIdentitiesToHistogram,
  heatmapGradient,
  heatmapPalettePosition,
  heatmapPaletteRgb,
  identityColorRgba,
  linearRangePosition,
  normalizeHeatmapRange,
} from "../src/heatmap";

describe("heatmap controls", () => {
  it("keeps minimum, midpoint, and maximum ordered", () => {
    expect(normalizeHeatmapRange({ minimum: 95, midpoint: 88, maximum: 99 }, "minimum"))
      .toEqual({ minimum: 95, midpoint: 95, maximum: 99 });
    expect(normalizeHeatmapRange({ minimum: 70, midpoint: 88, maximum: 80 }, "maximum"))
      .toEqual({ minimum: 80, midpoint: 80, maximum: 80 });
    expect(normalizeHeatmapRange({ minimum: 0, midpoint: 40, maximum: 120 }, "midpoint"))
      .toEqual({ minimum: 80, midpoint: 80, maximum: 100 });
    expect(normalizeHeatmapRange({ minimum: 85.14, midpoint: 92.26, maximum: 99.94 }, "midpoint"))
      .toEqual({ minimum: 85.1, midpoint: 92.3, maximum: 99.9 });
  });

  it("ignores missing values and bins fixed-point identity", () => {
    const bins = new Uint32Array(101);
    addIdentitiesToHistogram(bins, new Uint16Array([7_001, 7_049, 9_999, 65_535]));
    expect(bins[70]).toBe(2);
    expect(bins[100]).toBe(1);
  });

  it("maps every palette to eleven normalized WebGL color stops", () => {
    const colors = heatmapPaletteRgb("spectral");
    expect(colors).toHaveLength(33);
    expect(Math.min(...colors)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...colors)).toBeLessThanOrEqual(1);
  });

  it("remaps the slider preview anchors and uses the selected plot background", () => {
    const gradient = heatmapGradient(
      "sunset",
      { minimum: 85, midpoint: 92, maximum: 100 },
      true,
    );
    expect(gradient).toContain("#050506 0%");
    expect(gradient).toContain("#050506 25%");
    expect(gradient).toContain("#e85d39 60%");
    expect(gradient).toContain("#310e43 100%");
  });

  it("keeps the legend axis linear while matching the adjustable palette midpoint", () => {
    const range = { minimum: 90.2, midpoint: 97.1, maximum: 100 };
    expect(linearRangePosition(range.midpoint, range)).toBeCloseTo(0.7040816);
    expect(heatmapPalettePosition(range.minimum, range)).toBe(0);
    expect(heatmapPalettePosition(range.midpoint, range)).toBe(0.5);
    expect(heatmapPalettePosition(range.maximum, range)).toBe(1);
  });

  it("matches the stable schema-1 similarity pixel golden", () => {
    const range = { minimum: 85, midpoint: 92, maximum: 100 };
    expect([65_535, 8_499, 8_500, 9_200, 10_000].flatMap(
      (identity) => identityColorRgba(identity, "sunset", range, false),
    )).toEqual([
      248, 247, 242, 255,
      248, 247, 242, 255,
      246, 236, 157, 255,
      232, 93, 57, 255,
      49, 14, 67, 255,
    ]);
  });
});
