export interface HeatmapRange {
  minimum: number;
  midpoint: number;
  maximum: number;
}

export const HEATMAP_PALETTES = {
  sunset: {
    label: "Sunset",
    colors: [
      "#f6ec9d", "#f4dc82", "#f2c76c", "#efad59", "#eb8746", "#e85d39",
      "#cf4638", "#ad323b", "#86233e", "#5a1541", "#310e43",
    ],
  },
  spectral: {
    label: "ModDotPlot · Spectral",
    colors: [
      "#5e4fa2", "#3288bd", "#66c2a5", "#abdda4", "#e6f598", "#ffffbf",
      "#fee08b", "#fdae61", "#f46d43", "#d53e4f", "#9e0142",
    ],
  },
  viridis: {
    label: "Viridis",
    colors: [
      "#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89",
      "#35b779", "#6ece58", "#b5de2b", "#dce319", "#fde725",
    ],
  },
  blueRed: {
    label: "Blue–red",
    colors: [
      "#2166ac", "#4393c3", "#72b2d7", "#abd9e9", "#d9eef4", "#f7f7f7",
      "#f9d7c8", "#f4a582", "#e36b54", "#c9363e", "#b2182b",
    ],
  },
} as const;

export type HeatmapPalette = keyof typeof HEATMAP_PALETTES;

export const DEFAULT_HEATMAP_PALETTE: HeatmapPalette = "sunset";
export const LIGHT_PLOT_BACKGROUND = "#f8f7f2";
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

/** Returns the selected eleven-stop palette as normalized RGB triples for WebGL. */
export function heatmapPaletteRgb(palette: HeatmapPalette): Float32Array {
  return new Float32Array(
    HEATMAP_PALETTES[palette].colors.flatMap((color) => hexToRgb(color)),
  );
}

/** Returns the plot background as a normalized RGB triple for WebGL. */
export function plotBackgroundRgb(dark: boolean): readonly [number, number, number] {
  return hexToRgb(dark ? DARK_PLOT_BACKGROUND : LIGHT_PLOT_BACKGROUND);
}

/** Builds the slider preview with the same piecewise-linear anchor mapping as WebGL. */
export function heatmapGradient(
  palette: HeatmapPalette,
  range: HeatmapRange,
  darkBackground: boolean,
): string {
  const background = darkBackground ? DARK_PLOT_BACKGROUND : LIGHT_PLOT_BACKGROUND;
  const colors = HEATMAP_PALETTES[palette].colors;
  const minimumPosition = rangePosition(range.minimum);
  const colorStops = colors.map((color, index) => {
    const palettePosition = index / (colors.length - 1);
    const identity = palettePosition <= 0.5
      ? range.minimum + (range.midpoint - range.minimum) * palettePosition * 2
      : range.midpoint + (range.maximum - range.midpoint) * (palettePosition - 0.5) * 2;
    return `${color} ${formatPosition(rangePosition(identity))}`;
  });
  return `linear-gradient(90deg, ${background} 0%, ${background} ${formatPosition(minimumPosition)}, ${colorStops.join(", ")}, ${colors.at(-1)} 100%)`;
}

function clamp(value: number): number {
  return Math.max(80, Math.min(100, value));
}

function rangePosition(identity: number): number {
  return Math.max(0, Math.min(100, (identity - 80) * 5));
}

function formatPosition(position: number): string {
  return `${Number(position.toFixed(3))}%`;
}

function hexToRgb(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}
