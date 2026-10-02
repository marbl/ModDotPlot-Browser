import { describe, expect, it } from "vitest";
import {
  genomicMinimumViewportSize,
  initialViewport,
  panBy,
  remapViewportDomain,
  zoomAt,
} from "../src/viewport";

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

  it("converts the 100-base zoom floor into matrix coordinates", () => {
    expect(genomicMinimumViewportSize(1_000, 1_000_000)).toBeCloseTo(0.1);
    expect(genomicMinimumViewportSize(72, 72)).toBe(72);
    expect(genomicMinimumViewportSize(80, 80, 0)).toBe(0);
  });

  it("never zooms below 100 bp through wheel-like or keyboard-like factors", () => {
    const minimumSize = genomicMinimumViewportSize(1_000, 1_000_000);
    let wheelView = initialViewport(1_000, minimumSize);
    let keyboardView = initialViewport(1_000, minimumSize);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      wheelView = zoomAt(wheelView, 0.05, 0.13, 0.87);
      keyboardView = zoomAt(keyboardView, 0.8, 0.5, 0.5);
    }
    expect(wheelView.width).toBeCloseTo(minimumSize);
    expect(wheelView.height).toBeCloseTo(minimumSize);
    expect(keyboardView.width).toBeCloseTo(minimumSize);
    expect(keyboardView.height).toBeCloseTo(minimumSize);
    expect(wheelView.width / wheelView.domain * 1_000_000).toBeCloseTo(100);
    expect(wheelView.height / wheelView.domain * 1_000_000).toBeCloseTo(100);
  });

  it("preserves the normalized viewport when scientific resolution changes", () => {
    const view = {
      ...initialViewport(1000, 0.001),
      x: 200,
      y: 350,
      width: 250,
      height: 300,
    };
    expect(remapViewportDomain(view, 4000, 0.004)).toEqual({
      x: 800,
      y: 1400,
      width: 1000,
      height: 1200,
      domain: 4000,
      minSize: 0.004,
    });
  });
});
