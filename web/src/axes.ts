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
      context.moveTo(0, 0.5);
      context.lineTo(width, 0.5);
      context.stroke();
      drawTicksX(context, range.start, range.end, width);
      context.fillStyle = "#454149";
      context.font = "12px ui-sans-serif, system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText(ellipsize(this.#metadata.xName, 70), width / 2, height - 12);
    } else {
      context.beginPath();
      context.moveTo(width - 0.5, 0);
      context.lineTo(width - 0.5, height);
      context.stroke();
      drawTicksY(context, range.start, range.end, width, height);
      context.save();
      context.translate(12, height / 2);
      context.rotate(-Math.PI / 2);
      context.fillStyle = "#454149";
      context.font = "12px ui-sans-serif, system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText(ellipsize(this.#metadata.yName, 70), 0, 0);
      context.restore();
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

function drawTicksX(context: CanvasRenderingContext2D, start: number, end: number, width: number): void {
  const step = niceTickStep(end - start);
  context.textAlign = "center";
  context.textBaseline = "top";
  for (let value = Math.ceil(start / step) * step; value <= end; value += step) {
    const x = map(value, start, end, 0, width);
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, 6);
    context.stroke();
    context.textAlign = x < 38 ? "left" : x > width - 38 ? "right" : "center";
    context.fillText(formatAxisCoordinate(value), x, 8);
  }
}

function drawTicksY(context: CanvasRenderingContext2D, start: number, end: number, width: number, height: number): void {
  const step = niceTickStep(end - start);
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let value = Math.ceil(start / step) * step; value <= end; value += step) {
    const y = map(value, start, end, height, 0);
    const labelY = Math.max(7, Math.min(height - 7, y));
    context.beginPath();
    context.moveTo(width - 6, y);
    context.lineTo(width, y);
    context.stroke();
    context.fillText(formatAxisCoordinate(value), width - 9, labelY);
  }
}

function map(value: number, start: number, end: number, outputStart: number, outputEnd: number): number {
  return outputStart + (value - start) / Math.max(1e-12, end - start) * (outputEnd - outputStart);
}

function ellipsize(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
