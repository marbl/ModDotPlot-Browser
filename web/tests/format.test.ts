import { describe, expect, it } from "vitest";
import {
  formatAxisCoordinate,
  formatBases,
  formatBytes,
  formatCoordinate,
  formatInterval,
  formatPlotWindowSize,
} from "../src/format";

describe("coordinate formatting", () => {
  it("presents internal zero-based coordinates as one-based labels", () => {
    expect(formatCoordinate(0)).toBe("1");
    expect(formatCoordinate(999)).toBe("1,000");
  });

  it("keeps round axis milestones round while labeling the origin as one", () => {
    expect(formatAxisCoordinate(0)).toBe("1");
    expect(formatAxisCoordinate(1_000_000)).toBe("1,000,000");
  });

  it("formats genomic lengths compactly", () => {
    expect(formatBases(999)).toBe("999 bp");
    expect(formatBases(2_500_000)).toBe("2.5 Mb");
  });

  it("formats retained memory with binary units", () => {
    expect(formatBytes(157_286_400)).toBe("150 MiB");
  });

  it("presents half-open bins as one-based inclusive ranges", () => {
    expect(formatInterval(0, 1)).toBe("1");
    expect(formatInterval(999, 2000)).toBe("1,000–2,000");
  });

  it("reports a single representative scientific matrix-cell window size", () => {
    expect(formatPlotWindowSize(4_000_000, 1_000)).toBe("4 kb per cell");
    expect(formatPlotWindowSize(10, 3)).toBe("≈3 bp per cell");
    expect(formatPlotWindowSize(32_540_500, 1_000)).toBe("≈32,541 bp per cell");
    expect(formatPlotWindowSize(32, 32)).toBe("1 bp per cell");
    expect(formatPlotWindowSize(0, 1_000)).toBe("—");
  });
});
