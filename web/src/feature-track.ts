import type {
  FeatureTrackAxis,
  FeatureTrackKind,
  FeatureTrackPayload,
  FeatureTrackRequest,
} from "./protocol";
import type { ViewChange } from "./renderer";

export interface FeatureTrackMetadata {
  baseResolution: number;
  domainLength: number;
  xIndex: number;
  yIndex: number;
  xLength: number;
  yLength: number;
}

export type FeatureTrackSelection = Record<FeatureTrackKind, Record<FeatureTrackAxis, boolean>>;

interface TrackDefinition {
  kind: FeatureTrackKind;
  axis: FeatureTrackAxis;
  canvas: HTMLCanvasElement;
  maximum: number;
}

interface CachedTrack extends FeatureTrackPayload {}

export interface QuantitativeTrackHover {
  label: string;
  value: string;
  start: number;
  end: number;
}

export interface BarRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

const OVERSCAN_FACTOR = 1;
const MAX_DENSITY_RATIO = 1.25;

/** Builds overscanned requests with one unsmoothed sample per display pixel. */
export function featureTrackRequests(
  metadata: FeatureTrackMetadata,
  change: ViewChange,
  selection: FeatureTrackSelection,
): FeatureTrackRequest[] {
  const requests: FeatureTrackRequest[] = [];
  for (const axis of ["x", "y"] as const) {
    const length = axis === "x" ? metadata.xLength : metadata.yLength;
    const coordinate = axis === "x" ? change.view.x : change.view.y;
    const viewSpan = axis === "x" ? change.view.width : change.view.height;
    const pixelSpan = axis === "x" ? change.pixelWidth : change.pixelHeight;
    const genomicStart = coordinate / metadata.baseResolution * metadata.domainLength;
    const genomicSpan = viewSpan / metadata.baseResolution * metadata.domainLength;
    const start = Math.max(0, Math.min(length, genomicStart - genomicSpan * OVERSCAN_FACTOR));
    const end = Math.max(start, Math.min(length, genomicStart + genomicSpan * (1 + OVERSCAN_FACTOR)));
    const cachedBases = Math.max(1, Math.ceil(end) - Math.floor(start));
    const visibleBases = Math.max(1, genomicSpan);
    const bins = Math.max(
      1,
      Math.min(Math.ceil(pixelSpan * cachedBases / visibleBases), cachedBases),
    );
    for (const kind of ["gc", "cpg"] as const) {
      if (!selection[kind][axis]) continue;
      requests.push({
        kind,
        axis,
        sequenceIndex: axis === "x" ? metadata.xIndex : metadata.yIndex,
        start,
        end,
        bins,
      });
    }
  }
  return requests;
}

/** Returns the device-pixel rectangle for one discrete, axis-aligned bar. */
export function featureBarRectangle(
  axis: FeatureTrackAxis,
  value: number,
  startFraction: number,
  endFraction: number,
  width: number,
  height: number,
): BarRectangle | null {
  if (!Number.isFinite(value)) return null;
  const bounded = Math.max(0, Math.min(1, value));
  if (axis === "x") {
    const x = Math.floor(startFraction * width);
    const endX = Math.ceil(endFraction * width);
    const barHeight = Math.round(bounded * height);
    return { x, y: height - barHeight, width: Math.max(1, endX - x), height: barHeight };
  }
  const y = Math.floor((1 - endFraction) * height);
  const endY = Math.ceil((1 - startFraction) * height);
  const barWidth = Math.round(bounded * width);
  return { x: width - barWidth, y, width: barWidth, height: Math.max(1, endY - y) };
}

/** Owns stackable sequence-feature canvases and a view-aware overscan cache. */
export class FeatureTrackOverlay {
  readonly #definitions: TrackDefinition[];
  readonly #observer: ResizeObserver;
  readonly #cache = new Map<string, CachedTrack>();
  #metadata: FeatureTrackMetadata | null = null;
  #view: ViewChange | null = null;
  #hoverListener: ((hover: QuantitativeTrackHover | null, event: PointerEvent) => void) | null = null;

  constructor(definitions: TrackDefinition[]) {
    this.#definitions = definitions;
    this.#observer = new ResizeObserver(() => this.#resize());
    for (const definition of definitions) {
      this.#observer.observe(definition.canvas.parentElement ?? definition.canvas);
      definition.canvas.addEventListener("pointermove", (event) => this.#hover(definition, event));
      definition.canvas.addEventListener("pointerleave", (event) => this.#hoverListener?.(null, event));
    }
    this.#resize();
  }

  setView(metadata: FeatureTrackMetadata, view: ViewChange): void {
    this.#metadata = metadata;
    this.#view = view;
    this.#draw();
  }

  setData(payload: FeatureTrackPayload): void {
    this.#cache.set(trackKey(payload.kind, payload.axis), payload);
    this.#draw(payload.kind, payload.axis);
  }

  onHover(listener: (hover: QuantitativeTrackHover | null, event: PointerEvent) => void): void {
    this.#hoverListener = listener;
  }

  clear(kind?: FeatureTrackKind, axis?: FeatureTrackAxis): void {
    for (const definition of this.#definitions) {
      if (kind && definition.kind !== kind) continue;
      if (axis && definition.axis !== axis) continue;
      this.#cache.delete(trackKey(definition.kind, definition.axis));
      clearCanvas(definition.canvas);
    }
    if (!kind && !axis) {
      this.#metadata = null;
      this.#view = null;
    }
  }

  estimatedBytes(): number {
    return [...this.#cache.values()].reduce((total, cached) => total + cached.values.byteLength, 0);
  }

  #resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const definition of this.#definitions) {
      const canvas = definition.canvas;
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

  #draw(kind?: FeatureTrackKind, axis?: FeatureTrackAxis): void {
    for (const definition of this.#definitions) {
      if (kind && definition.kind !== kind) continue;
      if (axis && definition.axis !== axis) continue;
      this.#drawTrack(definition);
    }
  }

  #drawTrack(definition: TrackDefinition): void {
    const { canvas, kind, axis, maximum } = definition;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    const metadata = this.#metadata;
    const view = this.#view;
    const cached = this.#cache.get(trackKey(kind, axis));
    if (!metadata || !view || !cached || cached.values.length === 0) return;

    const coordinate = axis === "x" ? view.view.x : view.view.y;
    const matrixSpan = axis === "x" ? view.view.width : view.view.height;
    const pixelSpan = axis === "x" ? view.pixelWidth : view.pixelHeight;
    const length = axis === "x" ? metadata.xLength : metadata.yLength;
    const visibleStart = coordinate / metadata.baseResolution * metadata.domainLength;
    const visibleSpan = matrixSpan / metadata.baseResolution * metadata.domainLength;
    const visibleEnd = visibleStart + visibleSpan;
    const clippedStart = Math.max(0, Math.min(length, visibleStart));
    const clippedEnd = Math.max(clippedStart, Math.min(length, visibleEnd));
    const cachedSpan = cached.end - cached.start;
    const cachedBinSpan = cachedSpan / cached.values.length;
    const desiredBinSpan = visibleSpan / Math.max(1, pixelSpan);
    const tolerance = Math.max(1e-6, cachedBinSpan);
    if (
      clippedEnd <= clippedStart
      || cached.start > clippedStart + tolerance
      || cached.end < clippedEnd - tolerance
      || cachedBinSpan > desiredBinSpan * MAX_DENSITY_RATIO
    ) return;

    context.fillStyle = "#171717";
    for (let index = 0; index < cached.values.length; index += 1) {
      const genomicStart = cached.start + index / cached.values.length * cachedSpan;
      const genomicEnd = cached.start + (index + 1) / cached.values.length * cachedSpan;
      if (genomicEnd <= visibleStart || genomicStart >= visibleEnd) continue;
      const startFraction = (genomicStart - visibleStart) / visibleSpan;
      const endFraction = (genomicEnd - visibleStart) / visibleSpan;
      const value = (cached.values[index] ?? Number.NaN) / maximum;
      const rectangle = featureBarRectangle(
        axis,
        value,
        startFraction,
        endFraction,
        canvas.width,
        canvas.height,
      );
      if (!rectangle || rectangle.width === 0 || rectangle.height === 0) continue;
      context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    }
  }

  #hover(definition: TrackDefinition, event: PointerEvent): void {
    const listener = this.#hoverListener;
    const metadata = this.#metadata;
    const view = this.#view;
    const cached = this.#cache.get(trackKey(definition.kind, definition.axis));
    if (!listener || !metadata || !view || !cached || cached.values.length === 0) return;
    const bounds = definition.canvas.getBoundingClientRect();
    const fraction = definition.axis === "x"
      ? (event.clientX - bounds.left) / Math.max(1, bounds.width)
      : 1 - (event.clientY - bounds.top) / Math.max(1, bounds.height);
    const coordinate = definition.axis === "x" ? view.view.x : view.view.y;
    const matrixSpan = definition.axis === "x" ? view.view.width : view.view.height;
    const visibleStart = coordinate / metadata.baseResolution * metadata.domainLength;
    const visibleSpan = matrixSpan / metadata.baseResolution * metadata.domainLength;
    const genomicCoordinate = visibleStart + Math.max(0, Math.min(1, fraction)) * visibleSpan;
    const cachedSpan = cached.end - cached.start;
    if (cachedSpan <= 0) {
      listener(null, event);
      return;
    }
    const index = Math.floor((genomicCoordinate - cached.start) / Math.max(Number.EPSILON, cachedSpan) * cached.values.length);
    const rawValue = cached.values[index];
    if (rawValue === undefined || !Number.isFinite(rawValue)) {
      listener(null, event);
      return;
    }
    const start = cached.start + index / cached.values.length * cachedSpan;
    const end = cached.start + (index + 1) / cached.values.length * cachedSpan;
    listener({
      label: definition.kind === "gc" ? "GC%" : "CpG O/E",
      value: definition.kind === "gc" ? `${(rawValue * 100).toFixed(1)}%` : rawValue.toFixed(3),
      start,
      end,
    }, event);
  }
}

function trackKey(kind: FeatureTrackKind, axis: FeatureTrackAxis): string {
  return `${kind}:${axis}`;
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}
