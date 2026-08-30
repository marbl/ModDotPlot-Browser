import { selectRefinementTiles, type RefinementEvidence } from "./refinement";

interface RefinementState {
  refinementEvidence: ReadonlyMap<string, RefinementEvidence>;
  refinementDisplayMinimum: number;
}

export function allTileCoordinates(
  resolution: number,
  selfComparison: boolean,
): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < resolution; y += 256) {
    for (let x = selfComparison ? y : 0; x < resolution; x += 256) result.push({ x, y });
  }
  return result;
}

export function prioritizeForRefinement<T extends { x: number; y: number }>(
  resolution: number,
  tiles: T[],
  quality: "preview" | "refined",
  state: RefinementState,
): T[] {
  if (quality === "preview") return tiles;
  return selectRefinementTiles(resolution, tiles, state.refinementEvidence, {
    displayMinimum: state.refinementDisplayMinimum,
    refineAll: false,
  });
}

export function hasDetailedCandidates<T extends { x: number; y: number }>(
  resolution: number,
  tiles: T[],
  state: RefinementState,
): boolean {
  return prioritizeForRefinement(resolution, tiles, "refined", state).length > 0;
}
