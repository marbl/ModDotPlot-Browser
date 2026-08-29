import { describe, expect, it } from "vitest";
import {
  refinementKey,
  selectRefinementTiles,
  tileRefinementPriority,
} from "../src/refinement";

describe("display-uncertainty refinement", () => {
  it("settles missing, blank, and strongly supported high-identity tiles", () => {
    expect(tileRefinementPriority(new Uint16Array([0xffff, 8_000]), new Uint16Array([0, 0])))
      .toBe(0);
    expect(tileRefinementPriority(new Uint16Array([9_500]), new Uint16Array([8]))).toBe(0);
  });

  it("prioritizes boundary calls and low-support high-identity calls", () => {
    expect(tileRefinementPriority(new Uint16Array([8_500]), new Uint16Array([1]))).toBeGreaterThan(0);
    expect(tileRefinementPriority(new Uint16Array([9_500]), new Uint16Array([1]))).toBeGreaterThan(0);
  });

  it("selects only uncertain tiles unless high-sensitivity mode requests all", () => {
    const tiles = [{ x: 0, y: 0 }, { x: 256, y: 0 }, { x: 512, y: 0 }];
    const priorities = new Map([
      [refinementKey(1_000, 0, 0), 0],
      [refinementKey(1_000, 256, 0), 1],
      [refinementKey(1_000, 512, 0), 3],
    ]);
    expect(selectRefinementTiles(1_000, tiles, priorities, false)).toEqual([
      { x: 512, y: 0 },
      { x: 256, y: 0 },
    ]);
    expect(selectRefinementTiles(1_000, tiles, priorities, true)).toHaveLength(3);
  });
});
