import { describe, expect, it } from "vitest";
import {
  addIdentitiesToHistogram,
  discretePaletteIndex,
  heatmapGradient,
  heatmapPalettePosition,
  heatmapPaletteRgb,
  heatmapPaletteRgba,
  identityColorRgba,
  identityColorRgbaFromPalette,
  linearRangePosition,
  normalizeHeatmapColors,
  normalizeHeatmapRange,
  plotBackgroundRgba,
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
    const colors = heatmapPaletteRgb("Spectral");
    expect(colors).toHaveLength(33);
    expect(Math.min(...colors)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...colors)).toBeLessThanOrEqual(1);
  });

  it("remaps the slider preview anchors and uses the selected plot background", () => {
    const gradient = heatmapGradient(
      "Spectral",
      { minimum: 85, midpoint: 92, maximum: 100 },
      false,
    );
    expect(gradient).toContain("#ffffff 0%");
    expect(gradient).toContain("#ffffff 25%");
    expect(gradient).toContain("#ffffbf 56.818%");
    expect(gradient).toContain("#5e4fa2 100%");
  });

  it("renders exactly the requested number of discrete ColorBrewer classes", () => {
    const range = { minimum: 85, midpoint: 92, maximum: 100 };
    const colors = new Set([8_500, 8_800, 9_000, 9_200, 9_500, 10_000].map(
      (identity) => identityColorRgba(identity, "Spectral", range, false, 3).join(","),
    ));
    expect(colors).toEqual(new Set([
      "252,141,89,255",
      "255,255,191,255",
      "153,213,148,255",
    ]));
    expect(discretePaletteIndex(0, 3)).toBe(0);
    expect(discretePaletteIndex(1 / 3, 3)).toBe(1);
    expect(discretePaletteIndex(1, 3)).toBe(2);
  });

  it("uses one validated ordered color list for WebGL, CPU pixels, and the preview", () => {
    const colors = ["#102030", "#405060", "#708090"];
    expect([...heatmapPaletteRgb("Viridis", 3, colors)]).toEqual([...new Float32Array([
      16 / 255, 32 / 255, 48 / 255,
      64 / 255, 80 / 255, 96 / 255,
      112 / 255, 128 / 255, 144 / 255,
    ])]);
    expect(identityColorRgba(
      10_000,
      "Viridis",
      { minimum: 85, midpoint: 92, maximum: 100 },
      false,
      3,
      colors,
    )).toEqual([112, 128, 144, 255]);
    expect(heatmapGradient(
      "Viridis",
      { minimum: 85, midpoint: 92, maximum: 100 },
      false,
      3,
      colors,
    )).toContain("#708090 100%");
    expect(normalizeHeatmapColors("Viridis", 3, colors)).toEqual(colors);
    expect(() => normalizeHeatmapColors("Viridis", 3, ["#123456"])).toThrow(/Expected 3/);
    expect(() => normalizeHeatmapColors("Viridis", 3, ["#123456", "invalid", "#abcdef"]))
      .toThrow(/Invalid palette color/);
  });

  it("reuses predecoded palette and background colors in the CPU render hot path", () => {
    const colors = heatmapPaletteRgba(["#102030", "#405060", "#708090"]);
    const background = plotBackgroundRgba(false);
    const range = { minimum: 85, midpoint: 92, maximum: 100 };

    expect(identityColorRgbaFromPalette(10_000, colors, range, background)).toBe(colors[2]);
    expect(identityColorRgbaFromPalette(65_535, colors, range, background)).toBe(background);
    expect(identityColorRgbaFromPalette(8_499, colors, range, background)).toBe(background);
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
      (identity) => identityColorRgba(identity, "Spectral", range, false),
    )).toEqual([
      255, 255, 255, 255,
      255, 255, 255, 255,
      158, 1, 66, 255,
      255, 255, 191, 255,
      94, 79, 162, 255,
    ]);
  });
});
