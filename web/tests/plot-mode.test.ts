import { describe, expect, it } from "vitest";
import {
  MAX_GRID_SEQUENCES,
  normalizeGridSelections,
  planGridComparisons,
  validGridSizes,
  type PlotMode,
} from "../src/plot-mode";

describe("plot mode planning", () => {
  it("offers only distinct, bounded grid sizes", () => {
    expect(MAX_GRID_SEQUENCES).toBe(6);
    expect(validGridSizes(0)).toEqual([]);
    expect(validGridSizes(1)).toEqual([]);
    expect(validGridSizes(2)).toEqual([2]);
    expect(validGridSizes(4)).toEqual([2, 3, 4]);
    expect(validGridSizes(20)).toEqual([2, 3, 4, 5, 6]);
  });

  it("normalizes valid distinct selections and fills by loaded sequence index order", () => {
    expect(normalizeGridSelections(
      [17, 4, 29, 8],
      [29, 29, 999, 4],
      4,
    )).toEqual([29, 4, 17, 8]);
  });

  it("clamps selection count and ignores invalid available indexes", () => {
    expect(normalizeGridSelections(
      [5, 1, 9, 12, 20, 27, 31, 31, -1, 2.5],
      [31, 27, 20, 12, 9, 1, 5],
      99,
    )).toEqual([31, 27, 20, 12, 9, 1]);
    expect(normalizeGridSelections([7], [7], 2)).toEqual([]);
  });

  it("plans the lower triangle with columns on X and rows on Y", () => {
    expect(planGridComparisons([12, 4, 9])).toEqual([
      { row: 0, column: 0, xIndex: 12, yIndex: 12, selfComparison: true },
      { row: 1, column: 0, xIndex: 12, yIndex: 4, selfComparison: false },
      { row: 1, column: 1, xIndex: 4, yIndex: 4, selfComparison: true },
      { row: 2, column: 0, xIndex: 12, yIndex: 9, selfComparison: false },
      { row: 2, column: 1, xIndex: 4, yIndex: 9, selfComparison: false },
      { row: 2, column: 2, xIndex: 9, yIndex: 9, selfComparison: true },
    ]);
  });

  it("deduplicates and caps plans at six sequences", () => {
    const comparisons = planGridComparisons([7, 7, 2, 5, 11, 13, 17, 19]);
    expect(comparisons).toHaveLength(MAX_GRID_SEQUENCES * (MAX_GRID_SEQUENCES + 1) / 2);
    expect(comparisons.filter((comparison) => comparison.selfComparison)).toHaveLength(6);
    expect(comparisons.filter((comparison) => !comparison.selfComparison)).toHaveLength(15);
    expect(comparisons.at(-1)).toEqual({
      row: 5,
      column: 5,
      xIndex: 17,
      yIndex: 17,
      selfComparison: true,
    });
  });

  it("exposes the three supported plot modes", () => {
    const modes: PlotMode[] = ["self", "pairwise", "grid"];
    expect(modes).toEqual(["self", "pairwise", "grid"]);
  });
});
