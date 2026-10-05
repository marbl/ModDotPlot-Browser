import { formatAxisCoordinate } from "./format";
import type { AxisExportGeometry, AxisExportRange } from "./axes";
import type { ExportProvenance } from "./export";
import {
  isPaletteId,
  paletteDefaultColorCount,
} from "./palettes";
import {
  LIGHT_PLOT_BACKGROUND,
  discretePaletteIndex,
  heatmapPalettePosition,
  linearRangePosition,
  normalizeHeatmapColors,
  type HeatmapRange,
} from "./heatmap";

export type ImageExportFormat = "png" | "svg" | "pdf";

interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  opacity?: number;
}

interface SceneLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  width: number;
}

export interface SceneText {
  x: number;
  y: number;
  value: string;
  fill: string;
  size: number;
  weight?: "normal" | "bold";
  anchor?: "start" | "middle" | "end";
  rotation?: number;
}

export interface CompositeExportScene {
  width: number;
  height: number;
  plot: { x: number; y: number; width: number; height: number; png: Blob; dataUrl: string };
  rects: SceneRect[];
  lines: SceneLine[];
  texts: SceneText[];
  provenance: ExportProvenance;
}

/** Captures the visible layout while rebuilding every non-heatmap component as vectors. */
export async function createCompositeExportScene(
  shell: HTMLElement,
  plotFrame: HTMLElement,
  plotPng: Blob,
  axes: AxisExportGeometry,
  provenance: ExportProvenance,
): Promise<CompositeExportScene> {
  const shellBounds = shell.getBoundingClientRect();
  const plotBounds = relativeBounds(plotFrame, shellBounds);
  const legend = exportLegend(provenance);
  const legendMargin = legend
    ? legend.kind.startsWith("exact-") ? 170 : 120
    : 0;
  const scene: CompositeExportScene = {
    width: Math.max(1, Math.round(shellBounds.width + legendMargin)),
    height: Math.max(1, Math.round(shellBounds.height)),
    plot: { ...plotBounds, png: plotPng, dataUrl: await blobDataUrl(plotPng) },
    rects: [{ x: 0, y: 0, width: shellBounds.width + legendMargin, height: shellBounds.height, fill: "#f8f7f2" }],
    lines: [],
    texts: [],
    provenance,
  };

  scene.lines.push(...borderLines(plotBounds));
  addAxis(scene, shell.querySelector<HTMLElement>("#x-axis-panel"), axes.x, "x", shellBounds);
  addAxis(scene, shell.querySelector<HTMLElement>("#y-axis-panel"), axes.y, "y", shellBounds);
  addSequenceLabel(scene, shell.querySelector<HTMLElement>("#x-sequence-label"), "x", shellBounds);
  addSequenceLabel(scene, shell.querySelector<HTMLElement>("#y-sequence-label"), "y", shellBounds);
  for (const panel of shell.querySelectorAll<HTMLElement>(".feature-track-panel:not([hidden])")) {
    addTrack(scene, panel, shellBounds);
  }
  if (legend) addHeatmapLegend(scene, shellBounds.width, plotBounds, legend);
  return scene;
}

interface HeatmapExportLegend {
  kind: "heatmap";
  colors: readonly string[];
  range: HeatmapRange;
}

interface ExactBaseExportLegend {
  kind: "exact-bases";
  background: string;
}

interface ExactIdentityExportLegend {
  kind: "exact-identity";
  match: string;
  background: string;
}

interface ExactDirectionExportLegend {
  kind: "exact-direction";
  background: string;
}

interface DirectionExportLegend {
  kind: "direction";
  range: HeatmapRange;
  background: string;
}

type ExportLegend =
  | HeatmapExportLegend
  | ExactBaseExportLegend
  | ExactIdentityExportLegend
  | ExactDirectionExportLegend
  | DirectionExportLegend;

interface CategoricalLegendItem {
  label: string;
  fill: string;
}

/** Returns the ordered colors that a similarity export legend will actually render. */
export function heatmapLegendColors(provenance: ExportProvenance): readonly string[] | null {
  const legend = exportLegend(provenance);
  return legend?.kind === "heatmap" ? [...legend.colors] : null;
}

/** Returns the legend family that a composite image export will render. */
export function compositeExportLegendKind(provenance: ExportProvenance): ExportLegend["kind"] | null {
  return exportLegend(provenance)?.kind ?? null;
}

/** Returns exact categorical legend labels in their rendered order. */
export function exactExportLegendLabels(provenance: ExportProvenance): readonly string[] | null {
  const legend = exportLegend(provenance);
  if (!legend || !legend.kind.startsWith("exact-")) return null;
  return exactLegendItems(legend as ExactIdentityExportLegend | ExactBaseExportLegend | ExactDirectionExportLegend)
    .map((item) => item.label);
}

function exportLegend(provenance: ExportProvenance): ExportLegend | null {
  const display = provenance.display as {
    measurement?: string;
    exactVisualization?: string;
    colorMode?: string;
    background?: string;
    palette?: string;
    paletteColorCount?: number;
    paletteColors?: unknown;
    heatmapRange?: Partial<HeatmapRange>;
  } | null;
  const exact = display?.measurement === "kmer";
  const background = display?.background === "black" ? "#050506" : LIGHT_PLOT_BACKGROUND;
  if (exact && display?.colorMode === "direction") {
    return { kind: "exact-direction", background };
  }
  if (
    exact
    && display.exactVisualization === "bases"
  ) {
    return { kind: "exact-bases", background };
  }
  if (!display || !display.palette || !isPaletteId(display.palette)) return null;
  const range = display.heatmapRange;
  if (
    typeof range?.minimum !== "number"
    || typeof range.midpoint !== "number"
    || typeof range.maximum !== "number"
  ) return null;
  if (display.colorMode === "direction") {
    return {
      kind: "direction",
      range: range as HeatmapRange,
      background: display.background === "black" ? "#050506" : LIGHT_PLOT_BACKGROUND,
    };
  }
  const requestedColorCount = display.paletteColorCount;
  const colorCount = typeof requestedColorCount === "number"
    ? requestedColorCount
    : paletteDefaultColorCount(display.palette);
  let colors: string[];
  try {
    if (
      display.paletteColors !== undefined
      && (!Array.isArray(display.paletteColors)
        || !display.paletteColors.every((color): color is string => typeof color === "string"))
    ) return null;
    colors = normalizeHeatmapColors(
      display.palette,
      colorCount,
      display.paletteColors as string[] | undefined,
    );
  } catch {
    return null;
  }
  if (exact) {
    return {
      kind: "exact-identity",
      match: discretePaletteColor(colors, 1),
      background,
    };
  }
  return {
    kind: "heatmap",
    colors,
    range: range as HeatmapRange,
  };
}

function addHeatmapLegend(
  scene: CompositeExportScene,
  contentWidth: number,
  plotBounds: SceneRect,
  legend: ExportLegend,
): void {
  const barX = contentWidth + 24;
  if (legend.kind === "exact-identity") {
    addExactCategoricalLegend(scene, barX, Math.max(42, plotBounds.y), "Exact k-mer", legend);
    return;
  }
  if (legend.kind === "exact-bases") {
    addExactCategoricalLegend(scene, barX, Math.max(42, plotBounds.y), "Base", legend);
    return;
  }
  if (legend.kind === "exact-direction") {
    addExactCategoricalLegend(scene, barX, Math.max(42, plotBounds.y), "Orientation", legend);
    return;
  }
  if (legend.kind === "direction") {
    addDirectionLegend(scene, barX, Math.max(42, plotBounds.y), legend);
    return;
  }
  const barWidth = 18;
  const barTop = Math.max(42, plotBounds.y);
  const availableHeight = Math.max(80, scene.height - barTop - 42);
  const barHeight = Math.min(240, availableHeight);
  const steps = 80;
  for (let index = 0; index < steps; index += 1) {
    const identity = legend.range.maximum
      - index / Math.max(1, steps - 1) * (legend.range.maximum - legend.range.minimum);
    const position = heatmapPalettePosition(identity, legend.range);
    const y = barTop + index * barHeight / steps;
    scene.rects.push({
      x: barX,
      y,
      width: barWidth,
      height: barHeight / steps + 0.25,
      fill: discretePaletteColor(legend.colors, position),
    });
  }
  scene.lines.push(...borderLines({ x: barX, y: barTop, width: barWidth, height: barHeight }));
  scene.texts.push({
    x: barX,
    y: barTop - 17,
    value: "ANI_c",
    fill: "#242227",
    size: 11,
    weight: "bold",
  });
  const ticks = evenlySpacedLegendTicks(legend.range);
  for (const value of uniqueValues(ticks)) {
    const y = barTop + (1 - linearRangePosition(value, legend.range)) * barHeight;
    scene.lines.push({ x1: barX + barWidth, y1: y, x2: barX + barWidth + 5, y2: y, stroke: "#454149", width: 1 });
    scene.texts.push({
      x: barX + barWidth + 9,
      y,
      value: `${value.toFixed(1)}%`,
      fill: "#454149",
      size: 10,
    });
  }
}

function addDirectionLegend(
  scene: CompositeExportScene,
  x: number,
  y: number,
  legend: DirectionExportLegend,
): void {
  scene.texts.push({ x, y: y - 17, value: "Orientation", fill: "#242227", size: 11, weight: "bold" });
  const directions = [
    ["Forward", "#0e749f"],
    ["Reverse", "#cb3959"],
    ["Neutral", "#78737a"],
  ] as const;
  directions.forEach(([label, fill], index) => {
    const top = y + index * 24;
    scene.rects.push({ x, y: top, width: 16, height: 15, fill });
    scene.lines.push(...borderLines({ x, y: top, width: 16, height: 15 }));
    scene.texts.push({ x: x + 23, y: top + 7.5, value: label, fill: "#454149", size: 9 });
  });
  const barTop = y + 94;
  const barHeight = 120;
  const barWidth = 18;
  scene.texts.push({ x, y: barTop - 14, value: "ANI_c", fill: "#242227", size: 10, weight: "bold" });
  for (let index = 0; index < 50; index += 1) {
    const identity = legend.range.maximum
      - index / 49 * (legend.range.maximum - legend.range.minimum);
    const position = heatmapPalettePosition(identity, legend.range);
    scene.rects.push({
      x,
      y: barTop + index * barHeight / 50,
      width: barWidth,
      height: barHeight / 50 + 0.25,
      fill: interpolateHex(legend.background, "#78737a", position),
    });
  }
  scene.lines.push(...borderLines({ x, y: barTop, width: barWidth, height: barHeight }));
  const ticks = evenlySpacedLegendTicks(legend.range);
  for (const value of uniqueValues(ticks)) {
    const tickY = barTop + (1 - linearRangePosition(value, legend.range)) * barHeight;
    scene.lines.push({ x1: x + barWidth, y1: tickY, x2: x + barWidth + 5, y2: tickY, stroke: "#454149", width: 1 });
    scene.texts.push({ x: x + barWidth + 8, y: tickY, value: `${value.toFixed(1)}%`, fill: "#454149", size: 9 });
  }
}

export function evenlySpacedLegendTicks(range: HeatmapRange): number[] {
  const span = range.maximum - range.minimum;
  return Array.from({ length: 6 }, (_, index) => range.maximum - span * index / 5);
}

function uniqueValues(values: readonly number[]): number[] {
  return values.filter((value, index) => values.findIndex((candidate) => Math.abs(candidate - value) < 0.0001) === index);
}

function addExactCategoricalLegend(
  scene: CompositeExportScene,
  x: number,
  y: number,
  title: string,
  legend: ExactIdentityExportLegend | ExactBaseExportLegend | ExactDirectionExportLegend,
): void {
  scene.texts.push({ x, y: y - 17, value: title, fill: "#242227", size: 11, weight: "bold" });
  exactLegendItems(legend).forEach(({ label, fill }, index) => {
    const top = y + index * 24;
    scene.rects.push({ x, y: top, width: 16, height: 15, fill });
    scene.lines.push(...borderLines({ x, y: top, width: 16, height: 15 }));
    scene.texts.push({ x: x + 23, y: top + 7.5, value: label, fill: "#454149", size: 9 });
  });
}

function exactLegendItems(
  legend: ExactIdentityExportLegend | ExactBaseExportLegend | ExactDirectionExportLegend,
): readonly CategoricalLegendItem[] {
  const states: CategoricalLegendItem[] = [
    { label: "Mismatch / below threshold", fill: legend.background },
  ];
  if (legend.kind === "exact-identity") {
    return [{ label: "Exact match", fill: legend.match }, ...states];
  }
  if (legend.kind === "exact-bases") {
    return [
      { label: "A", fill: "#33ad3d" },
      { label: "C", fill: "#1f73e0" },
      { label: "G", fill: "#f5a31f" },
      { label: "T", fill: "#e03330" },
      ...states,
    ];
  }
  return [
    { label: "Forward", fill: "#0e749f" },
    { label: "Reverse", fill: "#cb3959" },
    { label: "Neutral", fill: "#78737a" },
    ...states,
  ];
}

function discretePaletteColor(
  colors: readonly string[],
  position: number,
): string {
  return colors[discretePaletteIndex(position, colors.length)]!;
}

function interpolateHex(lowColor: string, highColor: string, fraction: number): string {
  const low = hexBytes(lowColor);
  const high = hexBytes(highColor);
  const channels = low.map((value, index) => Math.round(value + (high[index]! - value) * fraction));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function hexBytes(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export async function renderCompositeExport(
  scene: CompositeExportScene,
  format: ImageExportFormat,
): Promise<Blob> {
  if (format === "svg") return renderSvg(scene);
  if (format === "pdf") return renderPdf(scene);
  return renderPng(scene);
}

function addAxis(
  scene: CompositeExportScene,
  panel: HTMLElement | null,
  range: AxisExportRange,
  axis: "x" | "y",
  root: DOMRect,
): void {
  if (!panel) return;
  const bounds = relativeBounds(panel, root);
  scene.rects.push({ ...bounds, fill: "#f8f7f2" });
  if (axis === "x") {
    scene.lines.push({ x1: bounds.x, y1: bounds.y + bounds.height - 0.5, x2: bounds.x + bounds.width, y2: bounds.y + bounds.height - 0.5, stroke: "#dcd8cf", width: 1 });
    for (const value of range.ticks) {
      const x = map(value, range.start, range.end, bounds.x, bounds.x + bounds.width);
      scene.lines.push({ x1: x, y1: bounds.y + bounds.height, x2: x, y2: bounds.y + bounds.height - 6, stroke: "#dcd8cf", width: 1 });
      scene.texts.push({
        x: Math.max(bounds.x + 2, Math.min(bounds.x + bounds.width - 2, x)),
        y: bounds.y + bounds.height - 9,
        value: formatAxisCoordinate(value),
        fill: "#6d6871",
        size: 11,
        anchor: x < bounds.x + 38 ? "start" : x > bounds.x + bounds.width - 38 ? "end" : "middle",
      });
    }
  } else {
    scene.lines.push({ x1: bounds.x + bounds.width - 0.5, y1: bounds.y, x2: bounds.x + bounds.width - 0.5, y2: bounds.y + bounds.height, stroke: "#dcd8cf", width: 1 });
    for (const value of range.ticks) {
      const y = map(value, range.start, range.end, bounds.y + bounds.height, bounds.y);
      scene.lines.push({ x1: bounds.x + bounds.width - 6, y1: y, x2: bounds.x + bounds.width, y2: y, stroke: "#dcd8cf", width: 1 });
      scene.texts.push({ x: bounds.x + bounds.width - 10, y, value: formatAxisCoordinate(value), fill: "#6d6871", size: 11, anchor: "middle", rotation: -90 });
    }
  }
}

function addSequenceLabel(
  scene: CompositeExportScene,
  element: HTMLElement | null,
  axis: "x" | "y",
  root: DOMRect,
): void {
  const value = element?.textContent?.trim();
  if (!element || !value) return;
  const bounds = relativeBounds(element, root);
  scene.texts.push({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
    value,
    fill: "#454149",
    size: 12,
    weight: "bold",
    anchor: "middle",
    rotation: axis === "y" ? 90 : 0,
  });
}

function addTrack(scene: CompositeExportScene, panel: HTMLElement, root: DOMRect): void {
  const bounds = relativeBounds(panel, root);
  if (bounds.width < 1 || bounds.height < 1) return;
  scene.rects.push({ ...bounds, fill: "#f8f7f2" });
  scene.lines.push(...borderLines(bounds));
  const canvas = panel.querySelector<HTMLCanvasElement>("canvas");
  if (canvas) scene.rects.push(...canvasVectorRuns(canvas, bounds));
  const label = panel.querySelector<HTMLElement>(".feature-track-name")?.textContent?.trim();
  if (label) {
    const vertical = panel.classList.contains("feature-track-panel-y");
    scene.texts.push({
      x: vertical ? bounds.x + bounds.width - 7 : bounds.x + 5,
      y: vertical ? bounds.y + bounds.height - 6 : bounds.y + 10,
      value: label,
      fill: "#242227",
      size: 8,
      weight: "bold",
      anchor: vertical ? "end" : "start",
      rotation: vertical ? -90 : 0,
    });
  }
}

function canvasVectorRuns(canvas: HTMLCanvasElement, bounds: SceneRect): SceneRect[] {
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const sample = document.createElement("canvas");
  sample.width = width;
  sample.height = height;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(canvas, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const result: SceneRect[] = [];
  for (let y = 0; y < height; y += 1) {
    let start = 0;
    while (start < width) {
      const offset = (y * width + start) * 4;
      const red = pixels[offset]!;
      const green = pixels[offset + 1]!;
      const blue = pixels[offset + 2]!;
      const alpha = pixels[offset + 3]!;
      let end = start + 1;
      while (end < width) {
        const next = (y * width + end) * 4;
        if (pixels[next] !== red || pixels[next + 1] !== green || pixels[next + 2] !== blue || pixels[next + 3] !== alpha) break;
        end += 1;
      }
      if (alpha > 8) result.push({
        x: bounds.x + start,
        y: bounds.y + y,
        width: end - start,
        height: 1,
        fill: `rgb(${red},${green},${blue})`,
        opacity: alpha / 255,
      });
      start = end;
    }
  }
  return result;
}

function renderSvg(scene: CompositeExportScene): Blob {
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${round(scene.width)}" height="${round(scene.height)}" viewBox="0 0 ${round(scene.width)} ${round(scene.height)}">`,
    `<metadata>${escapeXml(JSON.stringify(scene.provenance))}</metadata>`,
  ];
  for (const rect of scene.rects) parts.push(`<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="${round(rect.height)}" fill="${rect.fill}"${rect.opacity === undefined ? "" : ` fill-opacity="${round(rect.opacity)}"`}/>`);
  const plot = scene.plot;
  parts.push(`<image x="${round(plot.x)}" y="${round(plot.y)}" width="${round(plot.width)}" height="${round(plot.height)}" preserveAspectRatio="none" href="${plot.dataUrl}" xlink:href="${plot.dataUrl}"/>`);
  for (const line of scene.lines) parts.push(`<line x1="${round(line.x1)}" y1="${round(line.y1)}" x2="${round(line.x2)}" y2="${round(line.y2)}" stroke="${line.stroke}" stroke-width="${round(line.width)}"/>`);
  for (const item of scene.texts) {
    const transform = item.rotation ? ` transform="rotate(${item.rotation} ${round(item.x)} ${round(item.y)})"` : "";
    parts.push(`<text x="${round(item.x)}" y="${round(item.y)}" fill="${item.fill}" font-family="Arial,Helvetica,sans-serif" font-size="${item.size}" font-weight="${item.weight ?? "normal"}" text-anchor="${item.anchor ?? "start"}" dominant-baseline="middle"${transform}>${escapeXml(item.value)}</text>`);
  }
  parts.push("</svg>");
  return new Blob([parts.join("\n")], { type: "image/svg+xml;charset=utf-8" });
}

async function renderPng(scene: CompositeExportScene): Promise<Blob> {
  const scale = Math.min(3, Math.max(1, window.devicePixelRatio || 1, 2));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(scene.width * scale);
  canvas.height = Math.round(scene.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser cannot create the image export canvas");
  context.scale(scale, scale);
  for (const rect of scene.rects) drawRect(context, rect);
  const plot = await createImageBitmap(scene.plot.png);
  context.drawImage(plot, scene.plot.x, scene.plot.y, scene.plot.width, scene.plot.height);
  plot.close();
  for (const line of scene.lines) {
    context.strokeStyle = line.stroke;
    context.lineWidth = line.width;
    context.beginPath();
    context.moveTo(line.x1, line.y1);
    context.lineTo(line.x2, line.y2);
    context.stroke();
  }
  for (const item of scene.texts) drawText(context, item);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("The browser could not encode the PNG export")),
    "image/png",
  ));
}

async function renderPdf(scene: CompositeExportScene): Promise<Blob> {
  const image = await createImageBitmap(scene.plot.png);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser cannot create the PDF heatmap image");
  context.drawImage(image, 0, 0);
  image.close();
  const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("The browser could not encode the PDF heatmap image")),
    "image/jpeg",
    0.95,
  ));
  const jpegBytes = new Uint8Array(await jpeg.arrayBuffer());
  const commands: string[] = [];
  for (const rect of scene.rects) {
    const [r, g, b] = rgb(rect.fill);
    commands.push(`${round(r)} ${round(g)} ${round(b)} rg ${round(rect.x)} ${round(scene.height - rect.y - rect.height)} ${round(rect.width)} ${round(rect.height)} re f`);
  }
  commands.push(`q ${round(scene.plot.width)} 0 0 ${round(scene.plot.height)} ${round(scene.plot.x)} ${round(scene.height - scene.plot.y - scene.plot.height)} cm /Plot Do Q`);
  for (const line of scene.lines) {
    const [r, g, b] = rgb(line.stroke);
    commands.push(`${round(r)} ${round(g)} ${round(b)} RG ${round(line.width)} w ${round(line.x1)} ${round(scene.height - line.y1)} m ${round(line.x2)} ${round(scene.height - line.y2)} l S`);
  }
  for (const item of scene.texts) commands.push(pdfTextCommand(item, scene.height));
  const content = encode(commands.join("\n"));
  const objects: Uint8Array[] = [];
  objects.push(encode("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(encode("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  objects.push(encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(scene.width)} ${round(scene.height)}] /Resources << /Font << /F1 4 0 R >> /XObject << /Plot 5 0 R >> >> /Contents 6 0 R >>`));
  objects.push(encode("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  objects.push(concatBytes(
    encode(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`),
    jpegBytes,
    encode("\nendstream"),
  ));
  objects.push(concatBytes(encode(`<< /Length ${content.length} >>\nstream\n`), content, encode("\nendstream")));
  objects.push(encode(`<< /Producer (moddotplot-interactive) /Subject (${pdfEscape(JSON.stringify(scene.provenance))}) >>`));
  const assembled = assemblePdf(objects);
  const pdf = new Uint8Array(assembled.length);
  pdf.set(assembled);
  return new Blob([pdf.buffer], { type: "application/pdf" });
}

function assemblePdf(objects: Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = [encode("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n")];
  const offsets = [0];
  let length = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const wrapped = concatBytes(encode(`${index + 1} 0 obj\n`), object, encode("\nendobj\n"));
    chunks.push(wrapped);
    length += wrapped.length;
  });
  const xref = length;
  const entries = offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  chunks.push(encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return concatBytes(...chunks);
}

function pdfTextCommand(item: SceneText, pageHeight: number): string {
  const [r, g, b] = rgb(item.fill);
  const placement = pdfTextPlacement(item, pageHeight);
  return `${round(r)} ${round(g)} ${round(b)} rg BT /F1 ${round(item.size)} Tf ${round(placement.a)} ${round(placement.b)} ${round(placement.c)} ${round(placement.d)} ${round(placement.x)} ${round(placement.y)} Tm (${pdfEscape(item.value)}) Tj ET`;
}

export function pdfTextPlacement(item: SceneText, pageHeight: number): {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  y: number;
  anchorOffset: number;
  baselineOffset: number;
} {
  const estimatedWidth = item.value.length * item.size * 0.52;
  const anchorOffset = item.anchor === "middle" ? estimatedWidth / 2 : item.anchor === "end" ? estimatedWidth : 0;
  const baselineOffset = item.size * 0.34;
  const angle = (item.rotation ?? 0) * Math.PI / 180;
  const a = Math.cos(angle);
  const b = -Math.sin(angle);
  const c = Math.sin(angle);
  const d = Math.cos(angle);
  const anchorX = item.x;
  const anchorY = pageHeight - item.y;
  return {
    a,
    b,
    c,
    d,
    x: anchorX - anchorOffset * a - baselineOffset * c,
    y: anchorY - anchorOffset * b - baselineOffset * d,
    anchorOffset,
    baselineOffset,
  };
}

function drawRect(context: CanvasRenderingContext2D, rect: SceneRect): void {
  context.save();
  context.globalAlpha = rect.opacity ?? 1;
  context.fillStyle = rect.fill;
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.restore();
}

function drawText(context: CanvasRenderingContext2D, item: SceneText): void {
  context.save();
  context.translate(item.x, item.y);
  context.rotate((item.rotation ?? 0) * Math.PI / 180);
  context.fillStyle = item.fill;
  context.font = `${item.weight ?? "normal"} ${item.size}px Arial, Helvetica, sans-serif`;
  context.textAlign = item.anchor === "middle" ? "center" : item.anchor ?? "start";
  context.textBaseline = "middle";
  context.fillText(item.value, 0, 0);
  context.restore();
}

function relativeBounds(element: Element, root: DOMRect): SceneRect {
  const bounds = element.getBoundingClientRect();
  return { x: bounds.left - root.left, y: bounds.top - root.top, width: bounds.width, height: bounds.height, fill: "transparent" };
}

function borderLines(bounds: Pick<SceneRect, "x" | "y" | "width" | "height">): SceneLine[] {
  return [
    { x1: bounds.x, y1: bounds.y, x2: bounds.x + bounds.width, y2: bounds.y, stroke: "#dcd8cf", width: 1 },
    { x1: bounds.x + bounds.width, y1: bounds.y, x2: bounds.x + bounds.width, y2: bounds.y + bounds.height, stroke: "#dcd8cf", width: 1 },
    { x1: bounds.x + bounds.width, y1: bounds.y + bounds.height, x2: bounds.x, y2: bounds.y + bounds.height, stroke: "#dcd8cf", width: 1 },
    { x1: bounds.x, y1: bounds.y + bounds.height, x2: bounds.x, y2: bounds.y, stroke: "#dcd8cf", width: 1 },
  ];
}

function map(value: number, start: number, end: number, outputStart: number, outputEnd: number): number {
  return outputStart + (value - start) / Math.max(1e-12, end - start) * (outputEnd - outputStart);
}

function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [1, 3, 5].map((index) => Number.parseInt(hex[1]!.slice(index - 1, index + 1), 16) / 255) as [number, number, number];
  const channels = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [channels[0]! / 255, channels[1]! / 255, channels[2]! / 255];
}

function round(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function pdfEscape(value: string): string {
  return [...value].map((character) => character.charCodeAt(0) <= 255 ? character : "?").join("").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("\r", " ").replaceAll("\n", " ");
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read exported heatmap"));
    reader.readAsDataURL(blob);
  });
}
