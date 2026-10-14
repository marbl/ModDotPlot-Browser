import type { MatrixTilePayload } from "./protocol";
import type { ViewportState } from "./viewport";

const MISSING_IDENTITY = 65_535;
const DEFAULT_TILE_SIZE = 256;
const MAX_HISTOGRAM_SAMPLES = 256 * 256;

type HistogramTile = Pick<
  MatrixTilePayload,
  "quality" | "resolution" | "x" | "y" | "width" | "height" | "identity"
>;

/**
 * Builds an identity histogram for the visible viewport at one consistent
 * resolution. The finest completely cached non-preview level wins; while a
 * new detail level is loading, the complete lower-resolution level remains in
 * use instead of mixing or double-counting resolutions.
 */
export function visibleIdentityHistogram(
  tiles: Iterable<HistogramTile>,
  baseResolution: number,
  activeResolution: number,
  view: ViewportState,
  tileSize = DEFAULT_TILE_SIZE,
): Uint32Array {
  const bins = new Uint32Array(101);
  if (baseResolution <= 0 || activeResolution < baseResolution || tileSize <= 0) return bins;

  const byResolution = new Map<number, Map<string, HistogramTile>>();
  for (const tile of tiles) {
    if (
      tile.quality === "preview"
      || tile.resolution < baseResolution
      || tile.resolution > activeResolution
      || !tileIntersectsView(tile, baseResolution, view)
    ) continue;
    let level = byResolution.get(tile.resolution);
    if (!level) {
      level = new Map();
      byResolution.set(tile.resolution, level);
    }
    const key = `${tile.x}:${tile.y}`;
    const prior = level.get(key);
    if (!prior || qualityRank(tile.quality) > qualityRank(prior.quality)) level.set(key, tile);
  }

  const resolutions = [...byResolution.keys()].sort((left, right) => right - left);
  for (const resolution of resolutions) {
    const level = byResolution.get(resolution);
    if (!level) continue;
    const region = viewportCellRegion(view, baseResolution, resolution);
    if (!hasCompleteCoverage(level, region, tileSize)) continue;
    addVisibleIdentities(bins, level.values(), region);
    break;
  }
  return bins;
}

interface CellRegion {
  startX: number;
  endX: number;
  startY: number;
  endY: number;
}

function viewportCellRegion(
  view: ViewportState,
  baseResolution: number,
  resolution: number,
): CellRegion {
  const scale = resolution / baseResolution;
  return {
    startX: clamp(Math.floor(view.x * scale), 0, resolution),
    endX: clamp(Math.ceil((view.x + view.width) * scale), 0, resolution),
    startY: clamp(Math.floor(view.y * scale), 0, resolution),
    endY: clamp(Math.ceil((view.y + view.height) * scale), 0, resolution),
  };
}

function hasCompleteCoverage(
  tiles: ReadonlyMap<string, HistogramTile>,
  region: CellRegion,
  tileSize: number,
): boolean {
  if (region.startX >= region.endX || region.startY >= region.endY) return false;
  const firstX = Math.floor(region.startX / tileSize) * tileSize;
  const firstY = Math.floor(region.startY / tileSize) * tileSize;
  for (let y = firstY; y < region.endY; y += tileSize) {
    for (let x = firstX; x < region.endX; x += tileSize) {
      const tile = tiles.get(`${x}:${y}`);
      if (!tile) return false;
      const requiredEndX = Math.min(region.endX, x + tileSize);
      const requiredEndY = Math.min(region.endY, y + tileSize);
      if (
        tile.x > Math.max(region.startX, x)
        || tile.y > Math.max(region.startY, y)
        || tile.x + tile.width < requiredEndX
        || tile.y + tile.height < requiredEndY
      ) return false;
    }
  }
  return true;
}

function addVisibleIdentities(
  bins: Uint32Array,
  tiles: Iterable<HistogramTile>,
  region: CellRegion,
): void {
  const area = (region.endX - region.startX) * (region.endY - region.startY);
  const stride = Math.max(1, Math.ceil(Math.sqrt(area / MAX_HISTOGRAM_SAMPLES)));
  for (const tile of tiles) {
    const startX = Math.max(region.startX, tile.x);
    const endX = Math.min(region.endX, tile.x + tile.width);
    const startY = Math.max(region.startY, tile.y);
    const endY = Math.min(region.endY, tile.y + tile.height);
    if (startX >= endX || startY >= endY) continue;
    const firstY = startY + modulo(region.startY - startY, stride);
    const firstX = startX + modulo(region.startX - startX, stride);
    for (let y = firstY; y < endY; y += stride) {
      const row = (y - tile.y) * tile.width;
      for (let x = firstX; x < endX; x += stride) {
        const identity = tile.identity[row + x - tile.x];
        if (identity === undefined || identity === MISSING_IDENTITY) continue;
        const bin = Math.min(100, Math.max(0, Math.round(identity / 100)));
        bins[bin] = (bins[bin] ?? 0) + 1;
      }
    }
  }
}

function tileIntersectsView(
  tile: HistogramTile,
  baseResolution: number,
  view: ViewportState,
): boolean {
  const scale = baseResolution / tile.resolution;
  return (
    tile.x * scale < view.x + view.width
    && (tile.x + tile.width) * scale > view.x
    && tile.y * scale < view.y + view.height
    && (tile.y + tile.height) * scale > view.y
  );
}

function qualityRank(quality: HistogramTile["quality"]): number {
  return quality === "preview" ? 0 : quality === "refined" ? 1 : 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
