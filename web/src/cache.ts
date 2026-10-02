export interface CacheCandidate {
  key: string;
  resolution: number;
  lastUsed: number;
  visible: boolean;
}

/**
 * Selects the least-recently-used tile that is not needed for the current frame.
 *
 * The base overview is always retained. For visible content, the active resolution
 * and the best available lower-resolution fallback are also protected so eviction
 * cannot turn an interactive zoom into a blank viewport.
 */
export function selectTileEvictionCandidate(
  candidates: CacheCandidate[],
  baseResolution: number,
  activeResolution: number,
): CacheCandidate | null {
  const fallbackResolution = candidates.reduce((best, candidate) => {
    if (!candidate.visible || candidate.resolution >= activeResolution) return best;
    return Math.max(best, candidate.resolution);
  }, baseResolution);

  let oldest: CacheCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.resolution === baseResolution) continue;
    const protectedVisible = candidate.visible
      && (candidate.resolution === activeResolution || candidate.resolution === fallbackResolution);
    if (protectedVisible) continue;
    if (!oldest || candidate.lastUsed < oldest.lastUsed) oldest = candidate;
  }
  return oldest;
}
