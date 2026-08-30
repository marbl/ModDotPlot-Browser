/** Versioned separately from scientific tile configuration because it selects quality tiers. */
export const REFINEMENT_POLICY_VERSION = 1;
export const REFINEMENT_LOWER_IDENTITY = 8_200;
export const REFINEMENT_UPPER_IDENTITY = 9_000;
export const REFINEMENT_HIGH_SUPPORT = 8;

export function refinementKey(resolution: number, x: number, y: number): string {
  return `${resolution}:${x}:${y}`;
}

/**
 * Scores a provisional tile by display uncertainty, not raw numerical error.
 * Values near the reliable palette boundary and high-identity calls with little
 * verified support receive detailed work; settled blank or strongly supported tiles do not.
 */
export function tileRefinementPriority(
  identity: Uint16Array,
  support: Uint16Array,
): number {
  let score = 0;
  let informative = 0;
  for (let index = 0; index < identity.length; index += 1) {
    const value = identity[index]!;
    if (value === 0xffff) continue;
    const evidence = support[index]!;
    if (value >= REFINEMENT_LOWER_IDENTITY && value <= REFINEMENT_UPPER_IDENTITY) {
      score += 2 / Math.sqrt(evidence + 1);
      informative += 1;
    } else if (value > REFINEMENT_UPPER_IDENTITY && evidence < REFINEMENT_HIGH_SUPPORT) {
      score += 1 / Math.sqrt(evidence + 1);
      informative += 1;
    }
  }
  return informative === 0 ? 0 : score / informative;
}

export function selectRefinementTiles<T extends { x: number; y: number }>(
  resolution: number,
  tiles: T[],
  priorities: ReadonlyMap<string, number>,
  refineAll: boolean,
): T[] {
  const candidates = refineAll
    ? [...tiles]
    : tiles.filter((tile) => (priorities.get(refinementKey(resolution, tile.x, tile.y)) ?? 0) > 0);
  return candidates.sort((left, right) => {
    const rightPriority = priorities.get(refinementKey(resolution, right.x, right.y)) ?? 0;
    const leftPriority = priorities.get(refinementKey(resolution, left.x, left.y)) ?? 0;
    return rightPriority - leftPriority;
  });
}
