import { formatAxisCoordinate } from "./format";
import type { AxisExportGeometry, AxisExportRange } from "./axes";
import type { ExportProvenance } from "./export";

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

interface SceneText {
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
  const scene: CompositeExportScene = {
    width: Math.max(1, Math.round(shellBounds.width)),
    height: Math.max(1, Math.round(shellBounds.height)),
    plot: { ...plotBounds, png: plotPng, dataUrl: await blobDataUrl(plotPng) },
    rects: [{ x: 0, y: 0, width: shellBounds.width, height: shellBounds.height, fill: "#f8f7f2" }],
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
  return scene;
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
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(scene.width)}" height="${round(scene.height)}" viewBox="0 0 ${round(scene.width)} ${round(scene.height)}">`,
    `<metadata>${escapeXml(JSON.stringify(scene.provenance))}</metadata>`,
  ];
  for (const rect of scene.rects) parts.push(`<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.width)}" height="${round(rect.height)}" fill="${rect.fill}"${rect.opacity === undefined ? "" : ` fill-opacity="${round(rect.opacity)}"`}/>`);
  const plot = scene.plot;
  parts.push(`<image x="${round(plot.x)}" y="${round(plot.y)}" width="${round(plot.width)}" height="${round(plot.height)}" preserveAspectRatio="none" href="${plot.dataUrl}"/>`);
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
  objects.push(encode(`<< /Producer (moddotplot-rs) /Subject (${pdfEscape(JSON.stringify(scene.provenance))}) >>`));
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
  const estimatedWidth = item.value.length * item.size * 0.52;
  const offset = item.anchor === "middle" ? estimatedWidth / 2 : item.anchor === "end" ? estimatedWidth : 0;
  const angle = (item.rotation ?? 0) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = item.x - offset * cosine;
  const y = pageHeight - item.y - offset * sine - item.size * 0.34;
  return `${round(r)} ${round(g)} ${round(b)} rg BT /F1 ${round(item.size)} Tf ${round(cosine)} ${round(-sine)} ${round(sine)} ${round(cosine)} ${round(x)} ${round(y)} Tm (${pdfEscape(item.value)}) Tj ET`;
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
