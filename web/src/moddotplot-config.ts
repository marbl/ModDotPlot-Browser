import type { HeatmapRange } from "./heatmap";
import type { PlotMode } from "./plot-mode";
import type { ComparisonParameters, SequenceMetadata } from "./protocol";
import type { ViewportState } from "./viewport";

export interface ModDotPlotConfigContext {
  appVersion: string;
  baseName: string;
  plotMode: PlotMode;
  sequences: readonly SequenceMetadata[];
  gridSequenceIndices: readonly number[];
  parameters: ComparisonParameters;
  domainLength: number;
  currentResolution: number;
  viewport: ViewportState;
  palette: string;
  paletteReversed: boolean;
  paletteColors: readonly string[];
  heatmapRange: HeatmapRange;
  colorMode: "similarity" | "direction";
  loadFiles?: readonly string[];
}

export interface ModDotPlotCliConfig {
  load: string[];
  sequence: string[];
  region?: string[];
  kmer: number;
  window: number;
  modimizer: number;
  identity: number;
  delta: number;
  output_dir: string;
  compare: boolean;
  compare_only: boolean;
  compare_order: "sequential";
  grid: boolean;
  grid_only: boolean;
  palette: string;
  palette_orientation: "+" | "-";
  colors: string[];
  breakpoints: number[];
  plot_direction: boolean;
  no_bedpe: boolean;
  no_plot: boolean;
  no_hist: boolean;
  vector: "svg";
  _moddotplot_browser: {
    version: string;
    command: string;
    note: string;
    requested_bp_per_cell: number;
    exported_viewport: ViewportState;
  };
}

/**
 * Builds a config accepted by ModDotPlot's develop-branch static command. Unknown
 * underscore-prefixed metadata is intentionally ignored by its config loader.
 */
export function createModDotPlotCliConfig(context: ModDotPlotConfigContext): ModDotPlotCliConfig {
  const selected = selectedSequences(context);
  if (selected.length === 0) throw new Error("No selected sequences are available for the CLI config.");

  const requestedWindow = Math.max(1, Math.round(context.domainLength / context.currentResolution));
  // The official CLI rejects windows below 10 bp. Keep the file runnable while recording
  // the browser's exact requested cell size in the metadata block.
  const window = Math.max(10, context.parameters.k, requestedWindow);
  const outputBase = safePathPart(context.baseName) || "moddotplot-browser";
  const loadFiles = context.loadFiles?.length
    ? context.loadFiles.map((fileName) => `./${safePathPart(fileName) || "plot.bedpe"}`)
    : [`./${outputBase}.bedpe`];
  const regions = context.plotMode === "grid"
    ? undefined
    : visibleRegions(context);

  return {
    load: loadFiles,
    sequence: selected.map((sequence) => sequence.name),
    ...(regions && regions.length > 0 ? { region: regions } : {}),
    kmer: context.parameters.k,
    window,
    modimizer: Math.max(1, Math.min(window, context.parameters.detailedRegisterCount)),
    identity: cleanNumber(context.heatmapRange.minimum),
    delta: 0.5,
    output_dir: `${outputBase}-moddotplot-cli`,
    compare: false,
    compare_only: context.plotMode === "pairwise",
    compare_order: "sequential",
    grid: false,
    grid_only: context.plotMode === "grid",
    palette: officialPaletteName(context.palette, context.paletteColors.length),
    palette_orientation: context.paletteReversed ? "-" : "+",
    colors: context.paletteColors.map((color) => color.toLowerCase()),
    breakpoints: paletteBreakpoints(context.heatmapRange, context.paletteColors.length),
    plot_direction: context.colorMode === "direction",
    no_bedpe: false,
    no_plot: false,
    no_hist: false,
    vector: "svg",
    _moddotplot_browser: {
      version: context.appVersion,
      command: context.plotMode === "grid"
        ? `moddotplot --grid-only -c ${outputBase}.config.json -l ${loadFiles.map((file) => file.slice(2)).join(" ")}`
        : `moddotplot -c ${outputBase}.config.json -l ${loadFiles[0]!.slice(2)}`,
      note: context.plotMode === "grid"
        ? "Loads every companion browser-exported self and unique pairwise BEDPE into a grid-only plot. Keep the config and BEDPE files together after extracting the ZIP package."
        : "Loads the companion browser-exported BEDPE. Keep the config and BEDPE together after extracting the ZIP package.",
      requested_bp_per_cell: requestedWindow,
      exported_viewport: { ...context.viewport },
    },
  };
}

export function createModDotPlotCliConfigBlob(context: ModDotPlotConfigContext): Blob {
  return new Blob(
    [`${JSON.stringify(createModDotPlotCliConfig(context), null, 2)}\n`],
    { type: "application/json" },
  );
}

export function paletteBreakpoints(range: HeatmapRange, colorCount: number): number[] {
  if (!Number.isSafeInteger(colorCount) || colorCount < 1) {
    throw new RangeError("A CLI palette must contain at least one color.");
  }
  if (range.maximum <= range.minimum) {
    return Array.from(
      { length: colorCount + 1 },
      (_, index) => cleanNumber(range.minimum + index * 0.0001),
    );
  }
  const collapsedAnchor = range.midpoint <= range.minimum || range.midpoint >= range.maximum;
  return Array.from({ length: colorCount + 1 }, (_, index) => {
    const position = index / colorCount;
    const value = collapsedAnchor
      ? range.minimum + (range.maximum - range.minimum) * position
      : position <= 0.5
      ? range.minimum + (range.midpoint - range.minimum) * position * 2
      : range.midpoint + (range.maximum - range.midpoint) * (position - 0.5) * 2;
    return cleanNumber(value);
  });
}

function selectedSequences(context: ModDotPlotConfigContext): SequenceMetadata[] {
  const byIndex = new Map(context.sequences.map((sequence) => [sequence.index, sequence]));
  const indices = context.plotMode === "grid"
    ? context.gridSequenceIndices
    : context.plotMode === "self"
      ? [context.parameters.xIndex]
      : [context.parameters.xIndex, context.parameters.yIndex];
  return distinct(indices).map((index) => byIndex.get(index)).filter(
    (sequence): sequence is SequenceMetadata => Boolean(sequence),
  );
}

function visibleRegions(context: ModDotPlotConfigContext): string[] | undefined {
  const x = context.sequences.find((sequence) => sequence.index === context.parameters.xIndex);
  const y = context.sequences.find((sequence) => sequence.index === context.parameters.yIndex);
  if (!x || !y) return undefined;

  const xInterval = intervalForAxis(
    context.viewport.x,
    context.viewport.width,
    x.length,
    context.domainLength,
    context.parameters.resolution,
  );
  const yInterval = intervalForAxis(
    context.viewport.y,
    context.viewport.height,
    y.length,
    context.domainLength,
    context.parameters.resolution,
  );
  const fullX = xInterval.start === 1 && xInterval.end === x.length;
  const fullY = yInterval.start === 1 && yInterval.end === y.length;
  if (fullX && fullY) return undefined;

  if (x.index === y.index) {
    return [`${x.name}:${Math.min(xInterval.start, yInterval.start)}-${Math.max(xInterval.end, yInterval.end)}`];
  }
  return [
    `${x.name}:${xInterval.start}-${xInterval.end}`,
    `${y.name}:${yInterval.start}-${yInterval.end}`,
  ];
}

function intervalForAxis(
  offset: number,
  span: number,
  sequenceLength: number,
  domainLength: number,
  baseResolution: number,
): { start: number; end: number } {
  const safeDomain = Math.max(1, domainLength);
  const safeResolution = Math.max(1, baseResolution);
  const start = Math.max(1, Math.min(sequenceLength, Math.floor(offset / safeResolution * safeDomain) + 1));
  const end = Math.max(start, Math.min(sequenceLength, Math.ceil((offset + span) / safeResolution * safeDomain)));
  return { start, end };
}

function officialPaletteName(palette: string, colorCount: number): string {
  return palette === "Viridis" ? "Spectral_11" : `${palette}_${colorCount}`;
}

function safePathPart(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

function cleanNumber(value: number): number {
  return Number(value.toFixed(4));
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
