import {
  DEFAULT_PALETTE,
  DEFAULT_PALETTE_COLOR_COUNT,
  HEATMAP_PALETTES,
  paletteColors,
  paletteDefaultColorCount,
  type PaletteId,
} from "./palettes";

export interface HeatmapRange {
  minimum: number;
  midpoint: number;
  maximum: number;
}

export type RgbaColor = readonly [number, number, number, number];

export { HEATMAP_PALETTES };
export type HeatmapPalette = PaletteId;
export const DEFAULT_HEATMAP_PALETTE: HeatmapPalette = DEFAULT_PALETTE;
export const DEFAULT_HEATMAP_COLOR_COUNT = DEFAULT_PALETTE_COLOR_COUNT;
export const LIGHT_PLOT_BACKGROUND = "#ffffff";
export const DARK_PLOT_BACKGROUND = "#050506";

/** Keeps the three handles ordered while preserving the handle the user moved. */
export function normalizeHeatmapRange(
  range: HeatmapRange,
  changed: keyof HeatmapRange,
): HeatmapRange {
  let { minimum, midpoint, maximum } = range;
  minimum = clamp(minimum);
  midpoint = clamp(midpoint);
  maximum = clamp(maximum);
  if (changed === "minimum") {
    midpoint = Math.max(midpoint, minimum);
    maximum = Math.max(maximum, midpoint);
  } else if (changed === "maximum") {
    midpoint = Math.min(midpoint, maximum);
    minimum = Math.min(minimum, midpoint);
  } else {
    minimum = Math.min(minimum, midpoint);
    maximum = Math.max(maximum, midpoint);
  }
  return { minimum, midpoint, maximum };
}

/** Adds fixed-point identity values to 101 one-percent bins. */
export function addIdentitiesToHistogram(bins: Uint32Array, values: Uint16Array): void {
  if (bins.length !== 101) throw new Error("Identity histogram must have 101 bins");
  for (const value of values) {
    if (value === 65_535) continue;
    const percent = Math.min(100, Math.round(value / 100));
    bins[percent] = (bins[percent] ?? 0) + 1;
  }
}

/** Returns the selected application palette as normalized RGB triples for WebGL. */
export function heatmapPaletteRgb(
  palette: HeatmapPalette,
  colorCount = paletteDefaultColorCount(palette),
  colors?: readonly string[],
): Float32Array {
  return new Float32Array(
    normalizeHeatmapColors(palette, colorCount, colors).flatMap((color) => hexToRgb(color)),
  );
}

/** Decodes an already selected palette once for allocation-free CPU pixel lookup. */
export function heatmapPaletteRgba(colors: readonly string[]): RgbaColor[] {
  if (colors.length === 0) throw new RangeError("A heatmap palette must contain at least one color");
  return colors.map((color) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      throw new TypeError(`Invalid palette color: ${color}`);
    }
    return [...hexToRgbBytes(color), 255] as RgbaColor;
  });
}

/** Resolves and validates the exact ordered colors shared by every plot and export path. */
export function normalizeHeatmapColors(
  palette: HeatmapPalette,
  colorCount = paletteDefaultColorCount(palette),
  colors?: readonly string[],
): string[] {
  const canonical = paletteColors(palette, colorCount);
  if (colors === undefined) return [...canonical];
  if (colors.length !== colorCount) {
    throw new RangeError(`Expected ${colorCount} palette colors, received ${colors.length}`);
  }
  return colors.map((color) => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) {
      throw new TypeError(`Invalid palette color: ${color}`);
    }
    return color.toLowerCase();
  });
}

/** Returns the plot background as a normalized RGB triple for WebGL. */
export function plotBackgroundRgb(dark: boolean): readonly [number, number, number] {
  return hexToRgb(dark ? DARK_PLOT_BACKGROUND : LIGHT_PLOT_BACKGROUND);
}

/** Returns the selected plot background as byte RGBA for CPU rendering. */
export function plotBackgroundRgba(dark: boolean): RgbaColor {
  return [...hexToRgbBytes(dark ? DARK_PLOT_BACKGROUND : LIGHT_PLOT_BACKGROUND), 255];
}

/**
 * Allocation-free CPU palette lookup for render loops. The palette and background must be
 * decoded once with heatmapPaletteRgba and plotBackgroundRgba before entering the loop.
 */
export function identityColorRgbaFromPalette(
  encodedIdentity: number,
  paletteRgba: readonly RgbaColor[],
  range: HeatmapRange,
  background: RgbaColor,
): RgbaColor {
  if (encodedIdentity === 65_535 || encodedIdentity / 100 < range.minimum) return background;
  const position = heatmapPalettePosition(encodedIdentity / 100, range);
  return paletteRgba[discretePaletteIndex(position, paletteRgba.length)]!;
}

/** CPU reference for stable pixel goldens; mirrors the similarity fragment shader. */
export function identityColorRgba(
  encodedIdentity: number,
  palette: HeatmapPalette,
  range: HeatmapRange,
  darkBackground: boolean,
  colorCount = paletteDefaultColorCount(palette),
  paletteOverride?: readonly string[],
): RgbaColor {
  const background = plotBackgroundRgba(darkBackground);
  if (encodedIdentity === 65_535 || encodedIdentity / 100 < range.minimum) {
    return background;
  }
  const colors = normalizeHeatmapColors(palette, colorCount, paletteOverride);
  return identityColorRgbaFromPalette(
    encodedIdentity,
    heatmapPaletteRgba(colors),
    range,
    background,
  );
}

/** Maps a normalized palette position to one of the requested discrete classes. */
export function discretePaletteIndex(position: number, colorCount: number): number {
  if (!Number.isSafeInteger(colorCount) || colorCount < 1) {
    throw new RangeError("Palette color count must be a positive integer");
  }
  return Math.min(colorCount - 1, Math.floor(Math.max(0, Math.min(1, position)) * colorCount));
}

/** Maps an ANI_c percentage through the same adjustable three-anchor transfer function as WebGL. */
export function heatmapPalettePosition(identity: number, range: HeatmapRange): number {
  if (identity <= range.minimum) return 0;
  if (identity >= range.maximum) return 1;
  if (identity <= range.midpoint) {
    const lowerSpan = range.midpoint - range.minimum;
    return lowerSpan <= 0.001 ? 0.5 : 0.5 * (identity - range.minimum) / lowerSpan;
  }
  const upperSpan = range.maximum - range.midpoint;
  return upperSpan <= 0.001 ? 0.5 : 0.5 + 0.5 * (identity - range.midpoint) / upperSpan;
}

/** Places a value on a numerically linear minimum-to-maximum legend axis. */
export function linearRangePosition(value: number, range: Pick<HeatmapRange, "minimum" | "maximum">): number {
  const span = range.maximum - range.minimum;
  if (span <= 0.001) return 0.5;
  return Math.max(0, Math.min(1, (value - range.minimum) / span));
}

/** Builds the slider preview with the same piecewise-linear anchor mapping as WebGL. */
export function heatmapGradient(
  palette: HeatmapPalette,
  range: HeatmapRange,
  darkBackground: boolean,
  colorCount = paletteDefaultColorCount(palette),
  paletteOverride?: readonly string[],
): string {
  const background = darkBackground ? DARK_PLOT_BACKGROUND : LIGHT_PLOT_BACKGROUND;
  const colors = normalizeHeatmapColors(palette, colorCount, paletteOverride);
  const minimumPosition = rangePosition(range.minimum);
  const colorStops = colors.flatMap((color, index) => {
    const start = identityAtPalettePosition(index / colors.length, range);
    const end = identityAtPalettePosition((index + 1) / colors.length, range);
    return [
      `${color} ${formatPosition(rangePosition(start))}`,
      `${color} ${formatPosition(rangePosition(end))}`,
    ];
  });
  return `linear-gradient(90deg, ${background} 0%, ${background} ${formatPosition(minimumPosition)}, ${colorStops.join(", ")}, ${colors.at(-1)} 100%)`;
}

function identityAtPalettePosition(position: number, range: HeatmapRange): number {
  return position <= 0.5
    ? range.minimum + (range.midpoint - range.minimum) * position * 2
    : range.midpoint + (range.maximum - range.midpoint) * (position - 0.5) * 2;
}

function clamp(value: number): number {
  return Math.round(Math.max(80, Math.min(100, value)) * 10) / 10;
}

function rangePosition(identity: number): number {
  return Math.max(0, Math.min(100, (identity - 80) * 5));
}

function formatPosition(position: number): string {
  return `${Number(position.toFixed(3))}%`;
}

function hexToRgb(color: string): [number, number, number] {
  const bytes = hexToRgbBytes(color);
  return [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255];
}

function hexToRgbBytes(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
}
