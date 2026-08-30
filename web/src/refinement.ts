/** Versioned separately from scientific tile configuration because it selects quality tiers. */
export const REFINEMENT_POLICY_VERSION = 2;
export const REFINEMENT_DISPLAY_MARGIN = 500;
export const REFINEMENT_MIN_SUPPORT = 8;
export const REFINEMENT_EXPLORATION_MODULUS = 16;
const TILE_EDGE = 256;

export interface RefinementEvidence {
  minimumIdentity: number;
  maximumIdentity: number;
  nonMissingCells: number;
  missingCells: number;
  identityHistogram: Uint32Array;
  lowSupportHistogram: Uint32Array;
}

export interface RefinementPolicy {
  /** Fixed-point ANI_c display floor using the tile's 10,000 scale. */
  displayMinimum: number;
  refineAll: boolean;
}

export function refinementKey(resolution: number, x: number, y: number): string {
  return `${resolution}:${x}:${y}`;
}

/** Summarizes a provisional tile before its transferable channels leave the worker. */
export function summarizeRefinementEvidence(
  identity: Uint16Array,
  support: Uint16Array,
): RefinementEvidence {
  let minimumIdentity = 0xffff;
  let maximumIdentity = 0;
  let nonMissingCells = 0;
  let missingCells = 0;
  const identityHistogram = new Uint32Array(101);
  const lowSupportHistogram = new Uint32Array(101);
  for (let index = 0; index < identity.length; index += 1) {
    const value = identity[index]!;
    if (value === 0xffff) {
      missingCells += 1;
      continue;
    }
    nonMissingCells += 1;
    minimumIdentity = Math.min(minimumIdentity, value);
    maximumIdentity = Math.max(maximumIdentity, value);
    const bin = Math.min(100, Math.floor(value / 100));
    identityHistogram[bin] = (identityHistogram[bin] ?? 0) + 1;
    if (support[index]! < REFINEMENT_MIN_SUPPORT) {
      lowSupportHistogram[bin] = (lowSupportHistogram[bin] ?? 0) + 1;
    }
  }
  return {
    minimumIdentity,
    maximumIdentity,
    nonMissingCells,
    missingCells,
    identityHistogram,
    lowSupportHistogram,
  };
}

/** Scores evidence against the active display decision rather than a fixed ANI_c band. */
export function refinementPriority(
  evidence: RefinementEvidence,
  displayMinimum: number,
): number {
  if (evidence.nonMissingCells === 0) return 0;
  const lower = displayMinimum - REFINEMENT_DISPLAY_MARGIN;
  const upper = displayMinimum + REFINEMENT_DISPLAY_MARGIN;
  const firstBin = Math.max(0, Math.floor(lower / 100));
  const lastBin = Math.min(100, Math.ceil(upper / 100));
  const nearDecisionCells = sumBins(evidence.identityHistogram, firstBin, lastBin);
  const lowSupportCells = sumBins(evidence.lowSupportHistogram, firstBin, 100);
  const decisionFraction = nearDecisionCells / evidence.nonMissingCells;
  const lowSupportFraction = lowSupportCells / evidence.nonMissingCells;
  const missingFraction = evidence.missingCells
    / Math.max(1, evidence.nonMissingCells + evidence.missingCells);
  const decisionScore = nearDecisionCells >= Math.max(2, Math.ceil(evidence.nonMissingCells * 0.01))
    ? 1 + decisionFraction
    : 0;
  const supportScore = lowSupportCells >= Math.max(2, Math.ceil(evidence.nonMissingCells * 0.0025))
    ? 0.5 + lowSupportFraction
    : 0;
  const missingScore = evidence.maximumIdentity >= lower ? missingFraction * 0.25 : 0;
  return decisionScore + supportScore + missingScore;
}

/**
 * Selects uncertain tiles, their immediate structural neighbors, and a deterministic
 * sample of otherwise settled tiles. Exploration prevents a blank provisional region
 * from becoming a permanent exclusion rule while keeping most detailed work deferred.
 */
export function selectRefinementTiles<T extends { x: number; y: number }>(
  resolution: number,
  tiles: T[],
  evidence: ReadonlyMap<string, RefinementEvidence>,
  policy: RefinementPolicy,
): T[] {
  if (policy.refineAll) return [...tiles];
  const tileByCoordinate = new Map(tiles.map((tile) => [`${tile.x}:${tile.y}`, tile]));
  const scores = new Map<T, number>();
  for (const tile of tiles) {
    const summary = evidence.get(refinementKey(resolution, tile.x, tile.y));
    const score = summary ? refinementPriority(summary, policy.displayMinimum) : 0;
    if (score > 0) scores.set(tile, score);
  }
  for (const [tile, score] of [...scores]) {
    for (let deltaY = -TILE_EDGE; deltaY <= TILE_EDGE; deltaY += TILE_EDGE) {
      for (let deltaX = -TILE_EDGE; deltaX <= TILE_EDGE; deltaX += TILE_EDGE) {
        if (deltaX === 0 && deltaY === 0) continue;
        const neighbor = tileByCoordinate.get(`${tile.x + deltaX}:${tile.y + deltaY}`);
        if (neighbor) scores.set(neighbor, Math.max(scores.get(neighbor) ?? 0, score * 0.25));
      }
    }
  }
  for (const tile of tiles) {
    const xIndex = Math.floor(tile.x / TILE_EDGE);
    const yIndex = Math.floor(tile.y / TILE_EDGE);
    if ((xIndex + 3 * yIndex + resolution) % REFINEMENT_EXPLORATION_MODULUS === 0) {
      scores.set(tile, Math.max(scores.get(tile) ?? 0, 0.05));
    }
  }
  return [...scores].sort((left, right) =>
    right[1] - left[1] || left[0].y - right[0].y || left[0].x - right[0].x
  ).map(([tile]) => tile);
}

function sumBins(histogram: Uint32Array, first: number, last: number): number {
  let total = 0;
  for (let bin = first; bin <= last; bin += 1) total += histogram[bin] ?? 0;
  return total;
}
