export interface HeatmapRange {
  minimum: number;
  midpoint: number;
  maximum: number;
}

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

function clamp(value: number): number {
  return Math.max(80, Math.min(100, value));
}
