import type { TileCoordinate } from "./protocol";
import type { ViewportState } from "./viewport";

/** Selects a power-of-two detail level from zoom relative to the configured overview. */
export function selectDetailResolution(
  baseResolution: number,
  maximumResolution: number,
  view: ViewportState,
  _pixelWidth: number,
  _pixelHeight: number,
): number {
  const horizontalScale = view.domain / view.width;
  const verticalScale = view.domain / view.height;
  const demandScale = Math.max(1, horizontalScale, verticalScale);
  const levelScale = 2 ** Math.ceil(Math.log2(demandScale));
  return Math.min(Math.max(baseResolution, Math.floor(maximumResolution)), baseResolution * levelScale);
}

/** Returns visible tiles first, followed by a configurable surrounding prefetch halo. */
export function selectTiles(
  resolution: number,
  baseResolution: number,
  view: ViewportState,
  tileSize = 256,
  halo = 1,
): TileCoordinate[] {
  const coordinateScale = resolution / baseResolution;
  const firstX = Math.floor((view.x * coordinateScale) / tileSize);
  const firstY = Math.floor((view.y * coordinateScale) / tileSize);
  const lastX = Math.floor(
    (Math.max(view.x, view.x + view.width - 1e-9) * coordinateScale) / tileSize,
  );
  const lastY = Math.floor(
    (Math.max(view.y, view.y + view.height - 1e-9) * coordinateScale) / tileSize,
  );
  const finalTile = Math.ceil(resolution / tileSize) - 1;
  const tiles: TileCoordinate[] = [];
  const included = new Set<string>();
  const add = (tileX: number, tileY: number): void => {
    if (tileX < 0 || tileY < 0 || tileX > finalTile || tileY > finalTile) return;
    const key = `${tileX}:${tileY}`;
    if (included.has(key)) return;
    included.add(key);
    tiles.push({ x: tileX * tileSize, y: tileY * tileSize });
  };

  for (let tileY = firstY; tileY <= lastY; tileY += 1) {
    for (let tileX = firstX; tileX <= lastX; tileX += 1) add(tileX, tileY);
  }
  for (let tileY = firstY - halo; tileY <= lastY + halo; tileY += 1) {
    for (let tileX = firstX - halo; tileX <= lastX + halo; tileX += 1) add(tileX, tileY);
  }
  return tiles;
}
