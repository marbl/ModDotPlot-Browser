import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXACT_VISUALIZATION_MODE,
  RENDERER_FRAGMENT_SHADER_SOURCE,
  resolveCanvasPixelSize,
} from "../src/renderer";

describe("renderer exact-view defaults", () => {
  it("starts exact plots in base mode", () => {
    expect(DEFAULT_EXACT_VISUALIZATION_MODE).toBe("bases");
  });

  it("renders missing exact evidence as the selected plot background", () => {
    expect(RENDERER_FRAGMENT_SHADER_SOURCE).toMatch(
      /if \(encoded == 65535u\) \{\s*out_color = vec4\(u_background, 1\.0\);/,
    );
    expect(RENDERER_FRAGMENT_SHADER_SOURCE).not.toContain("u_missing");
  });
});

describe("renderer canvas sizing", () => {
  it("uses the bounding rectangle and DPR when device-pixel observation is unavailable", () => {
    expect(resolveCanvasPixelSize(320.25, 180.25, 2)).toEqual({
      width: 641,
      height: 361,
    });
  });

  it("retains exact device-pixel ResizeObserver measurements", () => {
    expect(resolveCanvasPixelSize(320.25, 180.25, 2, {
      inlineSize: 640,
      blockSize: 360,
    })).toEqual({
      width: 640,
      height: 360,
    });
  });

  it("caps both fallback and observed backing stores at three device pixels per CSS pixel", () => {
    expect(resolveCanvasPixelSize(100, 50, 4)).toEqual({ width: 300, height: 150 });
    expect(resolveCanvasPixelSize(100, 50, 4, {
      inlineSize: 400,
      blockSize: 200,
    })).toEqual({
      width: 300,
      height: 150,
    });
  });

  it("guards invalid and collapsed layout measurements", () => {
    expect(resolveCanvasPixelSize(0, 0, Number.NaN)).toEqual({ width: 1, height: 1 });
    expect(resolveCanvasPixelSize(20, 10, 2, {
      inlineSize: 0,
      blockSize: 0,
    })).toEqual({
      width: 40,
      height: 20,
    });
  });
});
