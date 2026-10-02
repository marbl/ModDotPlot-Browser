import { describe, expect, it } from "vitest";
import {
  DEFAULT_PALETTE,
  DEFAULT_PALETTE_COLOR_COUNT,
  DEFAULT_PALETTE_REVERSED,
  HEATMAP_PALETTES,
  PALETTE_GROUPS,
  PALETTE_IDS,
  isPaletteId,
  paletteColorCountRange,
  paletteColorCounts,
  paletteColors,
  paletteDefaultColorCount,
} from "../src/palettes";
import { paletteColors as colorBrewerColors } from "../src/colorbrewer";

describe("application palette catalog", () => {
  it("orders featured palettes before the remaining ColorBrewer categories", () => {
    expect(PALETTE_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      paletteIds: group.paletteIds,
    }))).toEqual([
      { id: "spectral", label: "Spectral", paletteIds: ["Spectral"] },
      { id: "viridis", label: "Viridis", paletteIds: ["Viridis"] },
      {
        id: "sequential",
        label: "Sequential",
        paletteIds: [
          "Blues", "BuGn", "BuPu", "GnBu", "Greens", "Greys", "Oranges",
          "OrRd", "PuBu", "PuBuGn", "PuRd", "Purples", "RdPu", "Reds",
          "YlGn", "YlGnBu", "YlOrBr", "YlOrRd",
        ],
      },
      {
        id: "diverging",
        label: "Diverging",
        paletteIds: [
          "BrBG", "PiYG", "PRGn", "PuOr", "RdBu", "RdGy", "RdYlBu",
          "RdYlGn",
        ],
      },
      {
        id: "qualitative",
        label: "Qualitative",
        paletteIds: [
          "Accent", "Dark2", "Paired", "Pastel1", "Pastel2", "Set1",
          "Set2", "Set3",
        ],
      },
    ]);

    const groupedIds = PALETTE_GROUPS.flatMap((group) => group.paletteIds);
    expect(groupedIds).toEqual(PALETTE_IDS);
    expect(new Set(groupedIds)).toHaveLength(36);
    expect(PALETTE_IDS.slice(0, 2)).toEqual(["Spectral", "Viridis"]);
  });

  it("defaults to reversed eleven-class Spectral", () => {
    expect(DEFAULT_PALETTE).toBe("Spectral");
    expect(DEFAULT_PALETTE_COLOR_COUNT).toBe(11);
    expect(DEFAULT_PALETTE_REVERSED).toBe(true);
  });

  it("provides Viridis variants from three through twelve colors", () => {
    expect(paletteColorCounts("Viridis")).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(paletteColorCountRange("Viridis")).toEqual({ min: 3, max: 12 });
    expect(paletteDefaultColorCount("Viridis")).toBe(12);
    expect(paletteColors("Viridis", 3)).toEqual([
      "#440154", "#21918c", "#fde725",
    ]);
    expect(paletteColors("Viridis", 5)).toEqual([
      "#440154", "#3b528b", "#21918c", "#5ec962", "#fde725",
    ]);
    expect(paletteColors("Viridis", 12)).toHaveLength(12);
  });

  it("retains exact ColorBrewer variants behind cloned immutable definitions", () => {
    const appSpectral = paletteColors("Spectral", 11);
    expect(appSpectral).toEqual(colorBrewerColors("Spectral", 11));
    expect(appSpectral).not.toBe(colorBrewerColors("Spectral", 11));
    expect(HEATMAP_PALETTES.Spectral.category).toBe("spectral");
    expect(HEATMAP_PALETTES.RdBu.category).toBe("diverging");

    expect(Object.isFrozen(PALETTE_GROUPS)).toBe(true);
    expect(Object.isFrozen(PALETTE_IDS)).toBe(true);
    expect(Object.isFrozen(HEATMAP_PALETTES)).toBe(true);
    for (const id of PALETTE_IDS) {
      const definition = HEATMAP_PALETTES[id];
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

  it("provides a generalized type guard and rejects unsupported counts", () => {
    expect(isPaletteId("Spectral")).toBe(true);
    expect(isPaletteId("Viridis")).toBe(true);
    expect(isPaletteId("viridis")).toBe(false);
    expect(isPaletteId("Turbo")).toBe(false);
    expect(paletteColorCountRange("Accent")).toEqual({ min: 3, max: 8 });
    expect(() => paletteColors("Viridis", 13)).toThrowError(
      "Viridis supports 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 colors; received 13.",
    );
  });
});
