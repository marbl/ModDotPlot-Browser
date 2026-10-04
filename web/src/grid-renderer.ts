import {
  DEFAULT_HEATMAP_COLOR_COUNT,
  DEFAULT_HEATMAP_PALETTE,
  DARK_PLOT_BACKGROUND,
  LIGHT_PLOT_BACKGROUND,
  heatmapPaletteRgba,
  heatmapPalettePosition,
  identityColorRgbaFromPalette,
  normalizeHeatmapColors,
  plotBackgroundRgba,
  type HeatmapPalette,
  type HeatmapRange,
  type RgbaColor,
} from "./heatmap";
import { paletteDefaultColorCount } from "./palettes";
import type { NumericTileView } from "./export";
import type { MatrixTilePayload } from "./protocol";

const MISSING_IDENTITY = 65_535;

export type GridColorMode = "similarity" | "direction";

interface CanvasSurface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  transposed: boolean;
}

/**
 * Lightweight Canvas2D renderer for one computed grid pair.
 *
 * The normal surface displays the pair exactly as computed. `domainScale` places that
 * pair on the grid's shared genomic axes (pair domain / longest selected domain), anchored
 * at the bottom-left origin. When supplied, the mirror surface displays the same retained
 * numeric tiles transposed, so an N-sequence grid can fill both off-diagonal cells without
 * retaining a second copy of every tile.
 */
export class GridPairRenderer {
  readonly #surfaces: CanvasSurface[];
  readonly #domainScale: number;
  readonly #tiles = new Map<string, MatrixTilePayload>();
  #mode: GridColorMode = "similarity";
  #palette: HeatmapPalette = DEFAULT_HEATMAP_PALETTE;
  #paletteColorCount = DEFAULT_HEATMAP_COLOR_COUNT;
  #paletteColors = normalizeHeatmapColors(DEFAULT_HEATMAP_PALETTE, DEFAULT_HEATMAP_COLOR_COUNT);
  #paletteRgba = heatmapPaletteRgba(this.#paletteColors);
  #range: HeatmapRange = { minimum: 85, midpoint: 92, maximum: 100 };
  #darkBackground = false;
  #destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    mirroredCanvas: HTMLCanvasElement | null = null,
    domainScale = 1,
  ) {
    if (!Number.isFinite(domainScale) || domainScale <= 0 || domainScale > 1) {
      throw new RangeError("Grid renderer domain scale must be greater than 0 and at most 1");
    }
    this.#domainScale = domainScale;
    this.#surfaces = [surface(canvas, false)];
    if (mirroredCanvas) this.#surfaces.push(surface(mirroredCanvas, true));
    this.redraw();
  }

  /** Retains a tile only when it is at least as authoritative as the cached tile. */
  addTile(payload: MatrixTilePayload): void {
    this.#assertAlive();
    validateTile(payload);
    const key = tileKey(payload);
    const prior = this.#tiles.get(key);
    if (prior && qualityRank(prior.quality) > qualityRank(payload.quality)) return;
    this.#tiles.set(key, payload);
    this.redraw();
  }

  setColorMode(mode: GridColorMode): void {
    this.#assertAlive();
    if (this.#mode === mode) return;
    this.#mode = mode;
    this.redraw();
  }

  setHeatmapPalette(
    palette: HeatmapPalette,
    colorCount = paletteDefaultColorCount(palette),
    colors?: readonly string[],
  ): void {
    this.#assertAlive();
    const nextColors = normalizeHeatmapColors(palette, colorCount, colors);
    if (
      this.#palette === palette
      && this.#paletteColorCount === colorCount
      && arraysEqual(this.#paletteColors, nextColors)
    ) return;
    this.#palette = palette;
    this.#paletteColorCount = colorCount;
    this.#paletteColors = nextColors;
    this.#paletteRgba = heatmapPaletteRgba(nextColors);
    this.redraw();
  }

  setHeatmapRange(minimum: number, midpoint: number, maximum: number): void {
    this.#assertAlive();
    const next = normalizedRange(minimum, midpoint, maximum);
    if (
      next.minimum === this.#range.minimum
      && next.midpoint === this.#range.midpoint
      && next.maximum === this.#range.maximum
    ) return;
    this.#range = next;
    this.redraw();
  }

  setDarkBackground(dark: boolean): void {
    this.#assertAlive();
    if (this.#darkBackground === dark) return;
    this.#darkBackground = dark;
    this.redraw();
  }

  /** Repaints after a caller changes either canvas's backing width or height. */
  redraw(): void {
    if (this.#destroyed) return;
    const tiles = [...this.#tiles.values()].sort((left, right) =>
      left.resolution - right.resolution
      || qualityRank(left.quality) - qualityRank(right.quality)
      || left.y - right.y
      || left.x - right.x
    );
    for (const target of this.#surfaces) this.#drawSurface(target, tiles);
  }

  /** Bytes retained in numeric tile channels. Canvas backing stores are externally owned. */
  estimatedBytes(): number {
    let bytes = 0;
    for (const tile of this.#tiles.values()) {
      bytes += tile.identity.byteLength
        + tile.direction.byteLength
        + tile.directionSupport.byteLength
        + (tile.bases?.byteLength ?? 0);
    }
    return bytes;
  }

  /** Exposes the retained scientific grid tiles for reproducible BEDPE export. */
  exportTileViews(): NumericTileView[] {
    this.#assertAlive();
    return [...this.#tiles.values()].map((tile) => ({
      configDigest: tile.configDigest,
      quality: tile.quality,
      resolution: tile.resolution,
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      identity: tile.identity,
      direction: tile.direction,
      directionSupport: tile.directionSupport,
    }));
  }

  /** Releases retained tile arrays and restores both canvases to the selected background. */
  clear(): void {
    this.#assertAlive();
    this.#tiles.clear();
    this.redraw();
  }

  /** Alias matching the interactive renderer's cache-clearing API. */
  clearTiles(): void {
    this.clear();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#tiles.clear();
    for (const target of this.#surfaces) paintBackground(target, this.#darkBackground);
    this.#destroyed = true;
  }

  #drawSurface(target: CanvasSurface, tiles: readonly MatrixTilePayload[]): void {
    const width = target.canvas.width;
    const height = target.canvas.height;
    if (width <= 0 || height <= 0) return;
    const image = target.context.createImageData(width, height);
    fillBackground(image.data, this.#darkBackground);
    const background = plotBackgroundRgba(this.#darkBackground);
    for (const tile of tiles) this.#drawTile(image, tile, target.transposed, background);
    target.context.putImageData(image, 0, 0);
  }

  #drawTile(
    image: ImageData,
    tile: MatrixTilePayload,
    transposed: boolean,
    background: RgbaColor,
  ): void {
    const resolution = tile.resolution;
    // Every grid canvas represents the same global genomic domain. The worker tile is
    // still computed over this pair's (possibly shorter) domain, so expand its logical
    // display resolution to leave the unused top/right portion of the global axes blank.
    const displayResolution = resolution / this.#domainScale;
    const matrixX = transposed ? tile.y : tile.x;
    const matrixY = transposed ? tile.x : tile.y;
    const matrixWidth = transposed ? tile.height : tile.width;
    const matrixHeight = transposed ? tile.width : tile.height;
    const columnStart = Math.max(0, Math.floor(matrixX / displayResolution * image.width));
    const columnEnd = Math.min(
      image.width,
      Math.ceil((matrixX + matrixWidth) / displayResolution * image.width),
    );
    const rowStart = Math.max(
      0,
      Math.floor((1 - (matrixY + matrixHeight) / displayResolution) * image.height),
    );
    const rowEnd = Math.min(
      image.height,
      Math.ceil((1 - matrixY / displayResolution) * image.height),
    );

    for (let row = rowStart; row < rowEnd; row += 1) {
      const targetY = Math.floor((1 - (row + 0.5) / image.height) * displayResolution);
      for (let column = columnStart; column < columnEnd; column += 1) {
        const targetX = Math.floor((column + 0.5) / image.width * displayResolution);
        const sourceX = transposed ? targetY - tile.x : targetX - tile.x;
        const sourceY = transposed ? targetX - tile.y : targetY - tile.y;
        if (
          sourceX < 0
          || sourceX >= tile.width
          || sourceY < 0
          || sourceY >= tile.height
        ) continue;
        const source = sourceY * tile.width + sourceX;
        const identity = tile.identity[source];
        const direction = tile.direction[source];
        const support = tile.directionSupport[source];
        if (identity === undefined || direction === undefined || support === undefined) continue;
        const color = this.#mode === "similarity"
          ? identityColorRgbaFromPalette(
            identity,
            this.#paletteRgba,
            this.#range,
            background,
          )
          : directionColorRgba(identity, direction, support, this.#range, this.#darkBackground);
        image.data.set(color, (row * image.width + column) * 4);
      }
    }
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("GridPairRenderer has been destroyed");
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** CPU counterpart to the interactive renderer's direction fragment-shader branch. */
export function directionColorRgba(
  encodedIdentity: number,
  encodedDirection: number,
  directionSupport: number,
  range: HeatmapRange,
  darkBackground: boolean,
): readonly [number, number, number, number] {
  const background = rgbBytes(darkBackground ? DARK_PLOT_BACKGROUND : LIGHT_PLOT_BACKGROUND);
  if (encodedIdentity === MISSING_IDENTITY || encodedIdentity / 100 < range.minimum) {
    return [...background, 255];
  }

  const position = heatmapPalettePosition(encodedIdentity / 100, range);
  const neutral = [0.47, 0.45, 0.48] as const;
  let directional: readonly [number, number, number] = neutral;
  if (directionSupport > 0) {
    const direction = Math.max(-1, Math.min(1, encodedDirection / 32_767));
    const selected = direction >= 0
      ? [0.055, 0.455, 0.624] as const
      : [0.795, 0.225, 0.350] as const;
    const confidence = Math.abs(direction) * (1 - Math.exp(-directionSupport / 8));
    directional = mixRgb(neutral, selected, confidence);
  }
  const normalizedBackground = background.map((channel) => channel / 255) as [number, number, number];
  const color = mixRgb(normalizedBackground, directional, position);
  return [byte(color[0]), byte(color[1]), byte(color[2]), 255];
}

function surface(canvas: HTMLCanvasElement, transposed: boolean): CanvasSurface {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D is required by the grid renderer");
  return { canvas, context, transposed };
}

function validateTile(tile: MatrixTilePayload): void {
  const cells = tile.width * tile.height;
  if (
    !Number.isSafeInteger(tile.resolution)
    || tile.resolution <= 0
    || !Number.isSafeInteger(tile.x)
    || !Number.isSafeInteger(tile.y)
    || !Number.isSafeInteger(tile.width)
    || !Number.isSafeInteger(tile.height)
    || tile.x < 0
    || tile.y < 0
    || tile.width <= 0
    || tile.height <= 0
    || tile.x + tile.width > tile.resolution
    || tile.y + tile.height > tile.resolution
    || tile.identity.length !== cells
    || tile.direction.length !== cells
    || tile.directionSupport.length !== cells
  ) {
    throw new Error("Grid tile channels or bounds are invalid");
  }
}

function normalizedRange(minimum: number, midpoint: number, maximum: number): HeatmapRange {
  const min = Math.max(0, Math.min(100, minimum));
  const max = Math.max(min, Math.min(100, maximum));
  return {
    minimum: min,
    midpoint: Math.max(min, Math.min(max, midpoint)),
    maximum: max,
  };
}

function tileKey(tile: MatrixTilePayload): string {
  return `${tile.resolution}:${tile.x}:${tile.y}`;
}

function qualityRank(quality: MatrixTilePayload["quality"]): number {
  return quality === "preview" ? 0 : quality === "refined" ? 1 : 2;
}

function paintBackground(target: CanvasSurface, dark: boolean): void {
  const width = target.canvas.width;
  const height = target.canvas.height;
  if (width <= 0 || height <= 0) return;
  const image = target.context.createImageData(width, height);
  fillBackground(image.data, dark);
  target.context.putImageData(image, 0, 0);
}

function fillBackground(data: Uint8ClampedArray, dark: boolean): void {
  const background = rgbBytes(dark ? DARK_PLOT_BACKGROUND : LIGHT_PLOT_BACKGROUND);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = background[0];
    data[offset + 1] = background[1];
    data[offset + 2] = background[2];
    data[offset + 3] = 255;
  }
}

function rgbBytes(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function mixRgb(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
  fraction: number,
): [number, number, number] {
  const bounded = Math.max(0, Math.min(1, fraction));
  return [
    left[0] + (right[0] - left[0]) * bounded,
    left[1] + (right[1] - left[1]) * bounded,
    left[2] + (right[2] - left[2]) * bounded,
  ];
}

function byte(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}
