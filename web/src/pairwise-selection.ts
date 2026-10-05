export type PairwiseAxis = "x" | "y";

export interface PairwiseSelection {
  xIndex: number;
  yIndex: number;
}

/**
 * Returns a valid, distinct pair while preserving the axis the user just changed.
 * The other axis moves deterministically when the requested choice would collide.
 */
export function normalizePairwiseSelection(
  availableIndices: readonly number[],
  selection: Partial<PairwiseSelection>,
  changedAxis?: PairwiseAxis,
): PairwiseSelection | null {
  const indices = [...new Set(availableIndices.filter(Number.isSafeInteger))];
  if (indices.length < 2) return null;

  let xIndex = indices.includes(selection.xIndex ?? Number.NaN)
    ? selection.xIndex!
    : indices[0]!;
  let yIndex = indices.includes(selection.yIndex ?? Number.NaN)
    ? selection.yIndex!
    : indices.find((index) => index !== xIndex)!;

  if (xIndex === yIndex) {
    if (changedAxis === "y") {
      xIndex = indices.find((index) => index !== yIndex)!;
    } else {
      yIndex = indices.find((index) => index !== xIndex)!;
    }
  }

  return { xIndex, yIndex };
}
