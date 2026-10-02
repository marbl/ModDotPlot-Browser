import { describe, expect, it } from "vitest";
import { formatFromFileName } from "../src/export-controller";

describe("native save target format", () => {
  it("uses the extension selected in the system picker", () => {
    expect(formatFromFileName("plot.svg", ["png", "svg", "pdf"], "png")).toBe("svg");
    expect(formatFromFileName("plot", ["png", "svg", "pdf"], "png")).toBe("png");
  });
});
