import { describe, expect, it } from "vitest";
import { createRulerAnchor, rulerDelta, rulerScreenPosition } from "../src/ruler";
import type { HoverDatum, ViewChange } from "../src/renderer";

describe("plot ruler", () => {
  it("measures signed distances between plot-cell centers", () => {
    const anchor = createRulerAnchor(hover({
      matrixX: 20,
      matrixY: 30,
      genomicXStart: 1_000,
      genomicXEnd: 1_100,
      genomicYStart: 2_000,
      genomicYEnd: 2_100,
    }));
    expect(rulerDelta(anchor, hover({
      genomicXStart: 1_450,
      genomicXEnd: 1_550,
      genomicYStart: 1_600,
      genomicYEnd: 1_700,
    }))).toEqual({ x: 450, y: -400 });
  });

  it("keeps the genomic anchor fixed while the viewport changes", () => {
    const change: ViewChange = {
      view: { x: 10, y: 20, width: 40, height: 40, domain: 100, minSize: 1 },
      pixelWidth: 800,
      pixelHeight: 600,
    };
    expect(rulerScreenPosition({ matrixX: 30, matrixY: 30, genomicX: 0, genomicY: 0 }, change))
      .toEqual({ x: 400, y: 450 });
    expect(rulerScreenPosition({ matrixX: 5, matrixY: 30, genomicX: 0, genomicY: 0 }, change))
      .toBeNull();
  });
});

function hover(overrides: Partial<HoverDatum>): HoverDatum {
  return {
    matrixX: 0,
    matrixY: 0,
    genomicXStart: 0,
    genomicXEnd: 1,
    genomicYStart: 0,
    genomicYEnd: 1,
    identity: 100,
    direction: 1,
    directionSupport: 1,
    quality: "refined",
    ...overrides,
  };
}
