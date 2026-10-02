import { describe, expect, it } from "vitest";
import {
  COLORBREWER_PALETTE_GROUPS,
  COLORBREWER_PALETTE_IDS,
  COLORBREWER_PALETTES,
  DEFAULT_COLORBREWER_COLOR_COUNT,
  DEFAULT_COLORBREWER_PALETTE,
  isColorBrewerPaletteId,
  paletteColorCountRange,
  paletteColorCounts,
  paletteColors,
  paletteDefaultColorCount,
} from "../src/colorbrewer";

describe("ColorBrewer palettes", () => {
  it("groups every palette once by ColorBrewer category", () => {
    expect(COLORBREWER_PALETTE_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      size: group.paletteIds.length,
    }))).toEqual([
      { id: "sequential", label: "Sequential", size: 18 },
      { id: "diverging", label: "Diverging", size: 9 },
      { id: "qualitative", label: "Qualitative", size: 8 },
    ]);

    const groupedIds = COLORBREWER_PALETTE_GROUPS.flatMap((group) => group.paletteIds);
    expect(groupedIds).toEqual(COLORBREWER_PALETTE_IDS);
    expect(new Set(groupedIds)).toHaveLength(35);
    for (const group of COLORBREWER_PALETTE_GROUPS) {
      for (const id of group.paletteIds) {
        expect(COLORBREWER_PALETTES[id]).toMatchObject({
          id,
          label: id,
          category: group.id,
        });
      }
    }
  });

  it("defaults to ColorBrewer's eleven-class Spectral scheme", () => {
    expect(DEFAULT_COLORBREWER_PALETTE).toBe("Spectral");
    expect(DEFAULT_COLORBREWER_COLOR_COUNT).toBe(11);
    expect(paletteDefaultColorCount(DEFAULT_COLORBREWER_PALETTE)).toBe(11);
    expect(paletteColors("Spectral", 11)).toEqual([
      "#9e0142", "#d53e4f", "#f46d43", "#fdae61", "#fee08b", "#ffffbf",
      "#e6f598", "#abdda4", "#66c2a5", "#3288bd", "#5e4fa2",
    ]);
  });

  it("exposes only published counts and exact count bounds", () => {
    expect(paletteColorCounts("Blues")).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(paletteColorCountRange("Blues")).toEqual({ min: 3, max: 9 });
    expect(paletteColorCounts("RdBu")).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(paletteColorCountRange("RdBu")).toEqual({ min: 3, max: 11 });
    expect(paletteColorCounts("Accent")).toEqual([3, 4, 5, 6, 7, 8]);
    expect(paletteColorCountRange("Paired")).toEqual({ min: 3, max: 12 });
    expect(paletteDefaultColorCount("Set1")).toBe(9);
  });

  it("returns authentic sequential, diverging, and qualitative variants", () => {
    expect(paletteColors("Blues", 3)).toEqual(["#deebf7", "#9ecae1", "#3182bd"]);
    expect(paletteColors("BrBG", 4)).toEqual([
      "#a6611a", "#dfc27d", "#80cdc1", "#018571",
    ]);
    expect(paletteColors("Accent", 3)).toEqual(["#7fc97f", "#beaed4", "#fdc086"]);
    expect(paletteColors("YlOrRd", 9)).toEqual([
      "#ffffcc", "#ffeda0", "#fed976", "#feb24c", "#fd8d3c", "#fc4e2a",
      "#e31a1c", "#bd0026", "#800026",
    ]);
    expect(paletteColors("Set3", 12)).toHaveLength(12);
  });

  it("keeps every variant internally consistent and immutable", () => {
    for (const id of COLORBREWER_PALETTE_IDS) {
      const definition = COLORBREWER_PALETTES[id];
      expect(definition.colorCounts[0]).toBe(definition.minColors);
      expect(definition.colorCounts.at(-1)).toBe(definition.maxColors);
      expect(definition.defaultColorCount).toBe(definition.maxColors);
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.colorCounts)).toBe(true);
      expect(Object.isFrozen(definition.colorsByCount)).toBe(true);
      for (const count of definition.colorCounts) {
        const colors = paletteColors(id, count);
        expect(colors).toHaveLength(count);
        expect(Object.isFrozen(colors)).toBe(true);
        expect(colors.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
      }
    }
  });

  it("provides a type guard and rejects unsupported class counts", () => {
    expect(isColorBrewerPaletteId("Spectral")).toBe(true);
    expect(isColorBrewerPaletteId("spectral")).toBe(false);
    expect(isColorBrewerPaletteId("Viridis")).toBe(false);
    expect(() => paletteColors("Accent", 9)).toThrowError(
      "Accent supports 3, 4, 5, 6, 7, 8 colors; received 9.",
    );
  });
});
