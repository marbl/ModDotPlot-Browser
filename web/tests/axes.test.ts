import { describe, expect, it } from "vitest";
import { niceTickStep } from "../src/axes";

describe("axis ticks", () => {
  it("uses stable 1-2-5 coordinate steps", () => {
    expect(niceTickStep(248_000_000)).toBe(50_000_000);
    expect(niceTickStep(8_900)).toBe(2_000);
    expect(niceTickStep(72)).toBe(20);
    expect(niceTickStep(0.8)).toBe(1);
  });
});
