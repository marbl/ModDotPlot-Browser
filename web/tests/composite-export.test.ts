import { describe, expect, it } from "vitest";
import {
  evenlySpacedLegendTicks,
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
});
