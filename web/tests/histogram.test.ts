import { describe, expect, it } from "vitest";
import { visibleIdentityHistogram } from "../src/histogram";
import type { MatrixTilePayload } from "../src/protocol";
import type { ViewportState } from "../src/viewport";

describe("visible identity histogram", () => {
  it("clips counts to the current viewport while panning", () => {
    const tile = histogramTile(4, 0, 0, 4, 2, [8_500, 8_600, 9_900, 10_000, 8_500, 8_600, 9_900, 10_000]);
    const left = visibleIdentityHistogram([tile], 4, 4, view(0, 0, 2, 2), 4);
    const right = visibleIdentityHistogram([tile], 4, 4, view(2, 0, 2, 2), 4);

    expect([left[85], left[86], left[99], left[100]]).toEqual([2, 2, 0, 0]);
    expect([right[85], right[86], right[99], right[100]]).toEqual([0, 0, 2, 2]);
  });

  it("uses a complete overview until the finer level fully covers the view", () => {
    const overview = histogramTile(2, 0, 0, 2, 2, [8_500, 8_500, 8_500, 8_500]);
    const detail = [
      histogramTile(4, 0, 0, 2, 2, [9_900, 9_900, 9_900, 9_900]),
      histogramTile(4, 2, 0, 2, 2, [9_900, 9_900, 9_900, 9_900]),
      histogramTile(4, 0, 2, 2, 2, [9_900, 9_900, 9_900, 9_900]),
      histogramTile(4, 2, 2, 2, 2, [9_900, 9_900, 9_900, 9_900]),
    ];

    const loading = visibleIdentityHistogram([overview, detail[0]!], 2, 4, view(0, 0, 2, 2), 2);
    expect(loading[85]).toBe(4);
    expect(loading[99]).toBe(0);

    const complete = visibleIdentityHistogram([overview, ...detail], 2, 4, view(0, 0, 2, 2), 2);
    expect(complete[85]).toBe(0);
    expect(complete[99]).toBe(16);
  });

  it("ignores preview and missing-identity cells", () => {
    const preview = histogramTile(2, 0, 0, 2, 2, [10_000, 10_000, 10_000, 10_000], "preview");
    const refined = histogramTile(2, 0, 0, 2, 2, [8_500, 65_535, 8_500, 65_535]);
    const bins = visibleIdentityHistogram([preview, refined], 2, 2, view(0, 0, 2, 2), 2);

    expect(bins[85]).toBe(2);
    expect(bins[100]).toBe(0);
  });

  it("bounds work for large visible matrices", () => {
    const side = 1_024;
    const tile = histogramTile(
      side,
      0,
      0,
      side,
      side,
      Array<number>(side * side).fill(9_200),
    );
    const bins = visibleIdentityHistogram([tile], side, side, view(0, 0, side, side), side);

    expect(bins[92]).toBe(256 * 256);
  });
});

function histogramTile(
  resolution: number,
  x: number,
  y: number,
  width: number,
  height: number,
  identities: number[],
  quality: MatrixTilePayload["quality"] = "refined",
): MatrixTilePayload {
  return {
    generation: 1,
    configDigest: "test",
    quality,
    resolution,
    x,
    y,
    width,
    height,
    identity: new Uint16Array(identities),
    direction: new Int16Array(width * height),
    directionSupport: new Uint16Array(width * height),
  };
}

function view(x: number, y: number, width: number, height: number): ViewportState {
  return { x, y, width, height, domain: 4, minSize: 1 };
}
