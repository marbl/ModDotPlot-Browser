import { describe, expect, it } from "vitest";
import { transposeTile } from "../src/tile";

describe("numeric tile transforms", () => {
  it("transposes every scientific channel and swaps edge dimensions", () => {
    const result = transposeTile(
      new Uint16Array([1, 2, 3, 4, 5, 6]),
      new Int16Array([-1, -2, -3, -4, -5, -6]),
      new Uint16Array([10, 20, 30, 40, 50, 60]),
      2,
      3,
    );
    expect([result.width, result.height]).toEqual([3, 2]);
    expect([...result.identity]).toEqual([1, 3, 5, 2, 4, 6]);
    expect([...result.direction]).toEqual([-1, -3, -5, -2, -4, -6]);
    expect([...result.directionSupport]).toEqual([10, 30, 50, 20, 40, 60]);
  });

  it("rejects mismatched channel dimensions", () => {
    expect(() =>
      transposeTile(new Uint16Array(3), new Int16Array(3), new Uint16Array(3), 2, 2),
    ).toThrow(/dimensions/);
  });
});
