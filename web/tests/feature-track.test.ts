import { describe, expect, it } from "vitest";
import { featureBarRectangle, featureTrackRequests } from "../src/feature-track";

describe("sequence feature tracks", () => {
  const metadata = {
    baseResolution: 1_000,
    domainLength: 10_000,
    xIndex: 2,
    yIndex: 4,
    xLength: 8_000,
    yLength: 10_000,
  };

  it("requests an overscanned, pixel-dense cache for each selected track", () => {
    const requests = featureTrackRequests(
      metadata,
      {
        view: { x: 100, y: 200, width: 500, height: 400, domain: 1_000, minSize: 1 },
        pixelWidth: 420,
        pixelHeight: 310,
      },
      {
        gc: { x: true, y: true },
        cpg: { x: true, y: false },
      },
    );

    expect(requests).toEqual([
      { kind: "gc", axis: "x", sequenceIndex: 2, start: 0, end: 8_000, bins: 672 },
      { kind: "cpg", axis: "x", sequenceIndex: 2, start: 0, end: 8_000, bins: 672 },
      { kind: "gc", axis: "y", sequenceIndex: 4, start: 0, end: 10_000, bins: 775 },
    ]);
  });

  it("clips overscan and padded domain regions to the selected sequence", () => {
    const requests = featureTrackRequests(
      metadata,
      {
        view: { x: 900, y: 0, width: 100, height: 1_000, domain: 1_000, minSize: 1 },
        pixelWidth: 500,
        pixelHeight: 500,
      },
      {
        gc: { x: true, y: false },
        cpg: { x: false, y: false },
      },
    );

    expect(requests).toEqual([
      { kind: "gc", axis: "x", sequenceIndex: 2, start: 8_000, end: 8_000, bins: 1 },
    ]);
  });

  it("maps values to unsmoothed bars rising away from the plot", () => {
    expect(featureBarRectangle("x", 0.5, 0.25, 0.5, 400, 32)).toEqual({
      x: 100,
      y: 16,
      width: 100,
      height: 16,
    });
    expect(featureBarRectangle("y", 0.25, 0, 0.25, 32, 400)).toEqual({
      x: 24,
      y: 300,
      width: 8,
      height: 100,
    });
    expect(featureBarRectangle("x", Number.NaN, 0, 1, 10, 10)).toBeNull();
  });
});
