import { formatAxisCoordinate } from "./format";
import type { ViewChange } from "./renderer";

interface AxisMetadata {
  baseResolution: number;
  domainLength: number;
  xName: string;
  yName: string;
  xLength: number;
  yLength: number;
}

type AxisName = "x" | "y";

export interface AxisExportGeometry {
  x: AxisExportRange;
  y: AxisExportRange;
}

export interface AxisExportRange {
  start: number;
  end: number;
  ticks: number[];
}

export class AxisOverlay {
  readonly #xCanvas: HTMLCanvasElement;
  readonly #yCanvas: HTMLCanvasElement;
  readonly #observer: ResizeObserver;
  #metadata: AxisMetadata = {
    baseResolution: 1,
    domainLength: 1,
    xName: "x",
    yName: "y",
    xLength: 1,
    yLength: 1,
  };
  #view: ViewChange | null = null;

  constructor(xCanvas: HTMLCanvasElement, yCanvas: HTMLCanvasElement) {
    this.#xCanvas = xCanvas;
    this.#yCanvas = yCanvas;
    this.#observer = new ResizeObserver(() => this.#resize());
    this.#observer.observe(xCanvas);
    this.#observer.observe(yCanvas);
    this.#resize();
  }

  setMetadata(metadata: AxisMetadata): void {
    this.#metadata = metadata;
    this.#draw();
  }

  setView(view: ViewChange): void {
    this.#view = view;
    this.#draw();
  }

  /** Coordinates and tick values used to rebuild axes as vectors during export. */
  exportGeometry(): AxisExportGeometry {
    const x = this.#visibleRange("x");
    const y = this.#visibleRange("y");
    return {
      x: { ...x, ticks: tickValues(x.start, x.end) },
      y: { ...y, ticks: tickValues(y.start, y.end) },
    };
  }

  #resize(): void {
    for (const canvas of [this.#xCanvas, this.#yCanvas]) {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const bounds = canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
    this.#draw();
  }

  #draw(): void {
    if (!this.#view) return;
    this.#drawAxis("x", this.#xCanvas);
    this.#drawAxis("y", this.#yCanvas);
  }

  #drawAxis(axis: AxisName, canvas: HTMLCanvasElement): void {
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#f8f7f2";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#dcd8cf";
    context.fillStyle = "#6d6871";
    context.font = "11px ui-sans-serif, system-ui, sans-serif";
    const range = this.#visibleRange(axis);
    if (axis === "x") {
      context.beginPath();
      context.moveTo(0, height - 0.5);
      context.lineTo(width, height - 0.5);
      context.stroke();
      drawTicksX(context, range.start, range.end, width, height);
    } else {
      context.beginPath();
      context.moveTo(width - 0.5, 0);
      context.lineTo(width - 0.5, height);
      context.stroke();
      drawTicksY(context, range.start, range.end, width, height);
    }
  }

  #visibleRange(axis: AxisName): { start: number; end: number } {
    const view = this.#view?.view;
    if (!view) return { start: 0, end: 1 };
    const start = (axis === "x" ? view.x : view.y) / this.#metadata.baseResolution * this.#metadata.domainLength;
    const span = (axis === "x" ? view.width : view.height) / this.#metadata.baseResolution * this.#metadata.domainLength;
    const length = axis === "x" ? this.#metadata.xLength : this.#metadata.yLength;
    return { start: Math.max(0, start), end: Math.min(length, start + span) };
  }
}

export function niceTickStep(span: number, targetTicks = 5): number {
  if (!(span > 0)) return 1;
  const rough = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const unit = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(1, unit * magnitude);
}

function tickValues(start: number, end: number): number[] {
  const step = niceTickStep(end - start);
  const ticks: number[] = [];
  for (let value = Math.ceil(start / step) * step; value <= end; value += step) ticks.push(value);
  return ticks;
}

function drawTicksX(
  context: CanvasRenderingContext2D,
  start: number,
  end: number,
  width: number,
  height: number,
): void {
  context.textAlign = "center";
  context.textBaseline = "bottom";
  for (const value of tickValues(start, end)) {
    const x = map(value, start, end, 0, width);
    context.beginPath();
    context.moveTo(x, height);
    context.lineTo(x, height - 6);
    context.stroke();
    context.textAlign = x < 38 ? "left" : x > width - 38 ? "right" : "center";
    context.fillText(formatAxisCoordinate(value), x, height - 8);
  }
}

function drawTicksY(context: CanvasRenderingContext2D, start: number, end: number, width: number, height: number): void {
  context.textAlign = "center";
  context.textBaseline = "bottom";
  for (const value of tickValues(start, end)) {
    const y = map(value, start, end, height, 0);
    const label = formatAxisCoordinate(value);
    const halfLabel = Math.min(height / 2 - 2, context.measureText(label).width / 2);
    const labelY = Math.max(halfLabel + 2, Math.min(height - halfLabel - 2, y));
    context.beginPath();
    context.moveTo(width - 6, y);
    context.lineTo(width, y);
    context.stroke();
    context.save();
    context.translate(width - 9, labelY);
    context.rotate(-Math.PI / 2);
    context.fillText(label, 0, 0);
    context.restore();
  }
}

function map(value: number, start: number, end: number, outputStart: number, outputEnd: number): number {
  return outputStart + (value - start) / Math.max(1e-12, end - start) * (outputEnd - outputStart);
}
