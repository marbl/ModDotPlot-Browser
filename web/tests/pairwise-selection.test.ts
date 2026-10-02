import { describe, expect, it } from "vitest";
import { normalizePairwiseSelection } from "../src/pairwise-selection";

describe("pairwise sequence selection", () => {
  it("chooses the first two distinct sequence indexes by default", () => {
    expect(normalizePairwiseSelection([7, 42, 99], { xIndex: 7, yIndex: 7 }))
      .toEqual({ xIndex: 7, yIndex: 42 });
  });

  it("preserves an existing distinct pair, including non-contiguous global indexes", () => {
    expect(normalizePairwiseSelection([7, 42, 99], { xIndex: 99, yIndex: 7 }))
      .toEqual({ xIndex: 99, yIndex: 7 });
  });

  it("moves the other axis when a changed selection would collide", () => {
    expect(normalizePairwiseSelection([7, 42], { xIndex: 42, yIndex: 42 }, "x"))
      .toEqual({ xIndex: 42, yIndex: 7 });
    expect(normalizePairwiseSelection([7, 42], { xIndex: 7, yIndex: 7 }, "y"))
      .toEqual({ xIndex: 42, yIndex: 7 });
  });

  it("repairs stale indexes and rejects fewer than two available sequences", () => {
    expect(normalizePairwiseSelection([7, 42], { xIndex: 500, yIndex: 500 }))
      .toEqual({ xIndex: 7, yIndex: 42 });
    expect(normalizePairwiseSelection([7], { xIndex: 7, yIndex: 7 })).toBeNull();
  });
});
