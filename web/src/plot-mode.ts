export type PlotMode = "self" | "pairwise" | "grid";

export const MAX_GRID_SEQUENCES = 6;

const MIN_GRID_SEQUENCES = 2;

export interface GridComparison {
  /** Position in the shared order; Y order is displayed from bottom to top. */
  row: number;
  /** Position in the shared order; X order is displayed from left to right. */
  column: number;
  /** The grid column supplies the X-axis sequence. */
  xIndex: number;
  /** The grid row supplies the Y-axis sequence. */
  yIndex: number;
  selfComparison: boolean;
}

/** Grid sizes that can be populated with distinct loaded sequences. */
export function validGridSizes(sequenceCount: number): number[] {
  const available = Number.isFinite(sequenceCount)
    ? Math.max(0, Math.floor(sequenceCount))
    : 0;
  const maximum = Math.min(MAX_GRID_SEQUENCES, available);
  if (maximum < MIN_GRID_SEQUENCES) return [];
  return Array.from(
    { length: maximum - MIN_GRID_SEQUENCES + 1 },
    (_, index) => index + MIN_GRID_SEQUENCES,
  );
}

/**
 * Keeps valid, distinct selections in their chosen order, then fills empty slots in
 * loaded-sequence order. Sequence indexes are identities and need not be contiguous.
 */
export function normalizeGridSelections(
  availableSequenceIndices: readonly number[],
  selectedSequenceIndices: readonly number[],
  requestedSize: number,
): number[] {
  const available = distinctSequenceIndices(availableSequenceIndices);
  const sizes = validGridSizes(available.length);
  if (sizes.length === 0) return [];

  const minimum = sizes[0]!;
  const maximum = sizes[sizes.length - 1]!;
  const requested = Number.isFinite(requestedSize) ? Math.floor(requestedSize) : minimum;
  const size = Math.max(minimum, Math.min(maximum, requested));
  const availableSet = new Set(available);
  const normalized: number[] = [];
  const selected = new Set<number>();

  for (const sequenceIndex of selectedSequenceIndices) {
    if (
      normalized.length === size
      || !availableSet.has(sequenceIndex)
      || selected.has(sequenceIndex)
    ) continue;
    normalized.push(sequenceIndex);
    selected.add(sequenceIndex);
  }

  for (const sequenceIndex of available) {
    if (normalized.length === size) break;
    if (selected.has(sequenceIndex)) continue;
    normalized.push(sequenceIndex);
    selected.add(sequenceIndex);
  }

  return normalized;
}

/**
 * Plans the unique lower triangle of the selected sequence matrix. Columns are X and
 * rows are Y, producing n self comparisons and n choose 2 pairwise comparisons.
 */
export function planGridComparisons(sequenceIndices: readonly number[]): GridComparison[] {
  const normalized = distinctSequenceIndices(sequenceIndices).slice(0, MAX_GRID_SEQUENCES);
  const comparisons: GridComparison[] = [];
  for (let row = 0; row < normalized.length; row += 1) {
    const yIndex = normalized[row]!;
    for (let column = 0; column <= row; column += 1) {
      const xIndex = normalized[column]!;
      comparisons.push({
        row,
        column,
        xIndex,
        yIndex,
        selfComparison: row === column,
      });
    }
  }
  return comparisons;
}

function distinctSequenceIndices(sequenceIndices: readonly number[]): number[] {
  const distinct: number[] = [];
  const seen = new Set<number>();
  for (const sequenceIndex of sequenceIndices) {
    if (!Number.isSafeInteger(sequenceIndex) || sequenceIndex < 0 || seen.has(sequenceIndex)) continue;
    distinct.push(sequenceIndex);
    seen.add(sequenceIndex);
  }
  return distinct;
}
