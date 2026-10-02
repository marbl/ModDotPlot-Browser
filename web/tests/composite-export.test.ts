import { describe, expect, it } from "vitest";
import {
  compositeExportLegendKind,
  evenlySpacedLegendTicks,
  exactExportLegendLabels,
  heatmapLegendColors,
  pdfTextPlacement,
  renderCompositeExport,
  type CompositeExportScene,
  type SceneText,
} from "../src/composite-export";

describe("portable vector export", () => {
  it("uses six evenly spaced ANI_c legend ticks independent of the palette midpoint", () => {
    expect(evenlySpacedLegendTicks({ minimum: 90.2, midpoint: 97.1, maximum: 100 }))
      .toEqual([100, 98.04, 96.08, 94.12, 92.16, 90.2]);
  });

  it("embeds the SVG heatmap with Illustrator-compatible xlink data", async () => {
    const scene: CompositeExportScene = {
      width: 100,
      height: 100,
      plot: {
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        png: new Blob(),
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
      rects: [],
      lines: [],
      texts: [],
      provenance: {} as CompositeExportScene["provenance"],
    };
    const svg = await (await renderCompositeExport(scene, "svg")).text();
    expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(svg).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(svg).toContain('xlink:href="data:image/png;base64,iVBORw0KGgo="');
  });

  it("centers rotated PDF text on the requested Y-axis tick", () => {
    const item: SceneText = {
      x: 50,
      y: 120,
      value: "50 Mb",
      fill: "#000000",
      size: 11,
      anchor: "middle",
      rotation: -90,
    };
    const placement = pdfTextPlacement(item, 400);
    const reconstructedX = placement.x
      + placement.anchorOffset * placement.a
      + placement.baselineOffset * placement.c;
    const reconstructedY = placement.y
      + placement.anchorOffset * placement.b
      + placement.baselineOffset * placement.d;
    expect(reconstructedX).toBeCloseTo(item.x);
    expect(reconstructedY).toBeCloseTo(400 - item.y);
  });

  it("uses customized display colors in the exported legend", () => {
    const provenance = {
      display: {
        measurement: "sketch",
        colorMode: "similarity",
        background: "white",
        palette: "Viridis",
        paletteColorCount: 3,
        paletteReversed: true,
        paletteColors: ["#abcdef", "#445566", "#112233"],
        heatmapRange: { minimum: 85, midpoint: 92, maximum: 100 },
      },
    } as CompositeExportScene["provenance"];
    expect(heatmapLegendColors(provenance)).toEqual(["#abcdef", "#445566", "#112233"]);

    const malformed = {
      ...provenance,
      display: { ...provenance.display as object, paletteColors: ["#abcdef"] },
    } as CompositeExportScene["provenance"];
    expect(heatmapLegendColors(malformed)).toBeNull();
  });

  it("uses scientifically explicit categorical legends for every exact view", () => {
    const display = {
      measurement: "kmer",
      colorMode: "similarity",
      background: "white",
      palette: "Spectral",
      paletteColorCount: 6,
      heatmapRange: { minimum: 85, midpoint: 92, maximum: 100 },
    };
    const identity = {
      display: { ...display, exactVisualization: "identity" },
    } as CompositeExportScene["provenance"];
    const bases = {
      display: { ...display, exactVisualization: "bases" },
    } as CompositeExportScene["provenance"];
    const direction = {
      display: { ...display, exactVisualization: "identity", colorMode: "direction" },
    } as CompositeExportScene["provenance"];

    expect(compositeExportLegendKind(identity)).toBe("exact-identity");
    expect(exactExportLegendLabels(identity)).toEqual([
      "Exact match",
      "Mismatch / below threshold",
    ]);
    expect(heatmapLegendColors(identity)).toBeNull();
    expect(compositeExportLegendKind(bases)).toBe("exact-bases");
    expect(exactExportLegendLabels(bases)).toEqual([
      "A",
      "C",
      "G",
      "T",
      "Mismatch / below threshold",
    ]);
    expect(heatmapLegendColors(bases)).toBeNull();
    expect(compositeExportLegendKind(direction)).toBe("exact-direction");
    expect(exactExportLegendLabels(direction)).toEqual([
      "Forward",
      "Reverse",
      "Neutral",
      "Mismatch / below threshold",
    ]);
  });
});
