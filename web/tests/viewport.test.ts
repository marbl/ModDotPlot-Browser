import { describe, expect, it } from "vitest";
import { initialViewport, panBy, zoomAt } from "../src/viewport";

describe("viewport transforms", () => {
  it("keeps the pointer anchor fixed while zooming", () => {
    const view = initialViewport(1000);
    const zoomed = zoomAt(view, 0.5, 0.25, 0.75);
    expect(zoomed.x + zoomed.width * 0.25).toBe(250);
    expect(zoomed.y + zoomed.height * 0.75).toBe(750);
  });

  it("clamps panning to the matrix domain", () => {
    const zoomed = zoomAt(initialViewport(1000), 0.25, 0.5, 0.5);
    expect(panBy(zoomed, -10_000, 10_000).x).toBe(0);
    expect(panBy(zoomed, -10_000, 10_000).y).toBe(750);
  });

  it("supports fractional matrix spans needed for base-resolution sequence views", () => {
    let view = initialViewport(1000, 0.000_004);
    for (let iteration = 0; iteration < 8; iteration += 1) {
      view = zoomAt(view, 0.05, 0.5, 0.5);
    }
    expect(view.width).toBeCloseTo(0.000_004);
    expect(view.height).toBeCloseTo(0.000_004);
  });
});
