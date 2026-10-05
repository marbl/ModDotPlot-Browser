export type CursorGuideGeometry = "axes" | "diagonals";
export type CursorGuideLineStyle = "dotted" | "dashed" | "solid";

export interface CursorGuideSettings {
  enabled: boolean;
  geometry: CursorGuideGeometry;
  style: CursorGuideLineStyle;
}

export const DEFAULT_CURSOR_GUIDE_SETTINGS: Readonly<CursorGuideSettings> = {
  enabled: true,
  geometry: "axes",
  style: "dotted",
};

export const CURSOR_GUIDE_CSS_PROPERTIES = {
  x: "--cursor-guide-x",
  y: "--cursor-guide-y",
  lineStyle: "--cursor-guide-line-style",
  firstAngle: "--cursor-guide-first-angle",
  secondAngle: "--cursor-guide-second-angle",
} as const;

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface CursorGuidePosition {
  /** Cursor position in the canvas-sized overlay. */
  x: number;
  y: number;
  /** Canvas bounds relative to the overlay's containing frame. */
  overlayLeft: number;
  overlayTop: number;
  overlayWidth: number;
  overlayHeight: number;
}

export interface CursorGuideControls {
  enabled?: HTMLInputElement;
  geometry?: HTMLSelectElement;
  style?: HTMLSelectElement;
}

export interface CursorGuideControllerOptions {
  frame: HTMLElement;
  canvas: HTMLCanvasElement;
  /**
   * An absolutely positioned element contained by `frame`. Its two line
   * children can use the exported CSS custom properties for positioning,
   * rotation, and border style.
   */
  overlay: HTMLElement;
  controls?: CursorGuideControls;
  settings?: Partial<CursorGuideSettings>;
}

const GUIDE_ANGLES: Record<CursorGuideGeometry, readonly [string, string]> = {
  axes: ["0deg", "90deg"],
  diagonals: ["45deg", "-45deg"],
};

export function normalizeCursorGuideSettings(
  settings: Partial<CursorGuideSettings> = {},
): CursorGuideSettings {
  return {
    enabled: typeof settings.enabled === "boolean"
      ? settings.enabled
      : DEFAULT_CURSOR_GUIDE_SETTINGS.enabled,
    geometry: settings.geometry === "axes" || settings.geometry === "diagonals"
      ? settings.geometry
      : DEFAULT_CURSOR_GUIDE_SETTINGS.geometry,
    style: settings.style === "dotted" || settings.style === "dashed" || settings.style === "solid"
      ? settings.style
      : DEFAULT_CURSOR_GUIDE_SETTINGS.style,
  };
}

/**
 * Converts a viewport pointer coordinate into canvas-local guide coordinates.
 * Returning null also gives callers a single, reliable way to hide guides when
 * the pointer is outside the rendered plot or layout has collapsed.
 */
export function resolveCursorGuidePosition(
  clientX: number,
  clientY: number,
  canvasRect: RectLike,
  frameRect: RectLike,
): CursorGuidePosition | null {
  if (
    !Number.isFinite(clientX)
    || !Number.isFinite(clientY)
    || !isFiniteRect(canvasRect)
    || !isFiniteRect(frameRect)
    || canvasRect.width <= 0
    || canvasRect.height <= 0
    || clientX < canvasRect.left
    || clientX > canvasRect.right
    || clientY < canvasRect.top
    || clientY > canvasRect.bottom
  ) {
    return null;
  }

  return {
    x: clamp(clientX - canvasRect.left, 0, canvasRect.width),
    y: clamp(clientY - canvasRect.top, 0, canvasRect.height),
    overlayLeft: canvasRect.left - frameRect.left,
    overlayTop: canvasRect.top - frameRect.top,
    overlayWidth: canvasRect.width,
    overlayHeight: canvasRect.height,
  };
}

export class CursorGuideController {
  readonly #frame: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #overlay: HTMLElement;
  readonly #controls: CursorGuideControls;
  #settings: CursorGuideSettings;
  #hasPointer = false;
  #lastClientPoint: readonly [number, number] | null = null;
  #resizeObserver: ResizeObserver | null = null;

  readonly #handlePointerMove = (event: PointerEvent): void => {
    this.moveToClientPoint(event.clientX, event.clientY);
  };

  readonly #handlePointerExit = (): void => {
    this.hide();
  };

  readonly #handleEnabledChange = (): void => {
    const control = this.#controls.enabled;
    if (control) this.setEnabled(control.checked);
  };

  readonly #handleGeometryChange = (): void => {
    const value = this.#controls.geometry?.value;
    if (value === "axes" || value === "diagonals") this.setGeometry(value);
  };

  readonly #handleStyleChange = (): void => {
    const value = this.#controls.style?.value;
    if (value === "dotted" || value === "dashed" || value === "solid") this.setLineStyle(value);
  };

  constructor(options: CursorGuideControllerOptions) {
    this.#frame = options.frame;
    this.#canvas = options.canvas;
    this.#overlay = options.overlay;
    this.#controls = options.controls ?? {};

    const controlSettings: Partial<CursorGuideSettings> = {};
    if (this.#controls.enabled) controlSettings.enabled = this.#controls.enabled.checked;
    const geometry = this.#controls.geometry?.value;
    if (geometry === "axes" || geometry === "diagonals") controlSettings.geometry = geometry;
    const style = this.#controls.style?.value;
    if (style === "dotted" || style === "dashed" || style === "solid") controlSettings.style = style;
    this.#settings = normalizeCursorGuideSettings({ ...controlSettings, ...options.settings });

    this.#overlay.style.pointerEvents = "none";
    this.#canvas.addEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.addEventListener("pointerleave", this.#handlePointerExit);
    this.#canvas.addEventListener("pointercancel", this.#handlePointerExit);
    this.#controls.enabled?.addEventListener("change", this.#handleEnabledChange);
    this.#controls.geometry?.addEventListener("change", this.#handleGeometryChange);
    this.#controls.style?.addEventListener("change", this.#handleStyleChange);

    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(() => this.refreshLayout());
      this.#resizeObserver.observe(this.#frame);
      this.#resizeObserver.observe(this.#canvas);
    }

    this.#syncControls();
    this.#applyAppearance();
    this.#applyVisibility();
  }

  get settings(): CursorGuideSettings {
    return { ...this.#settings };
  }

  setEnabled(enabled: boolean): void {
    this.#settings.enabled = enabled;
    this.#syncControls();
    this.#applyVisibility();
  }

  setGeometry(geometry: CursorGuideGeometry): void {
    this.#settings.geometry = geometry;
    this.#syncControls();
    this.#applyAppearance();
  }

  setLineStyle(style: CursorGuideLineStyle): void {
    this.#settings.style = style;
    this.#syncControls();
    this.#applyAppearance();
  }

  setSettings(settings: Partial<CursorGuideSettings>): void {
    this.#settings = normalizeCursorGuideSettings({ ...this.#settings, ...settings });
    this.#syncControls();
    this.#applyAppearance();
    this.#applyVisibility();
  }

  /** Update the guides from a pointer coordinate in viewport pixels. */
  moveToClientPoint(clientX: number, clientY: number): boolean {
    this.#lastClientPoint = [clientX, clientY];
    const position = resolveCursorGuidePosition(
      clientX,
      clientY,
      this.#canvas.getBoundingClientRect(),
      this.#frame.getBoundingClientRect(),
    );
    if (!position) {
      this.#hasPointer = false;
      this.#applyVisibility();
      return false;
    }

    this.#hasPointer = true;
    this.#applyPosition(position);
    this.#applyVisibility();
    return true;
  }

  /** Recalculate the overlay after a resize without waiting for pointer motion. */
  refreshLayout(): void {
    const point = this.#lastClientPoint;
    if (point) this.moveToClientPoint(point[0], point[1]);
  }

  hide(): void {
    this.#lastClientPoint = null;
    this.#hasPointer = false;
    this.#applyVisibility();
  }

  destroy(): void {
    this.#canvas.removeEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.removeEventListener("pointerleave", this.#handlePointerExit);
    this.#canvas.removeEventListener("pointercancel", this.#handlePointerExit);
    this.#controls.enabled?.removeEventListener("change", this.#handleEnabledChange);
    this.#controls.geometry?.removeEventListener("change", this.#handleGeometryChange);
    this.#controls.style?.removeEventListener("change", this.#handleStyleChange);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.hide();
  }

  #applyAppearance(): void {
    const [firstAngle, secondAngle] = GUIDE_ANGLES[this.#settings.geometry];
    this.#overlay.dataset.guideGeometry = this.#settings.geometry;
    this.#overlay.dataset.guideStyle = this.#settings.style;
    this.#overlay.style.setProperty(CURSOR_GUIDE_CSS_PROPERTIES.lineStyle, this.#settings.style);
    this.#overlay.style.setProperty(CURSOR_GUIDE_CSS_PROPERTIES.firstAngle, firstAngle);
    this.#overlay.style.setProperty(CURSOR_GUIDE_CSS_PROPERTIES.secondAngle, secondAngle);
  }

  #applyPosition(position: CursorGuidePosition): void {
    this.#overlay.style.left = cssPixels(position.overlayLeft);
    this.#overlay.style.top = cssPixels(position.overlayTop);
    this.#overlay.style.width = cssPixels(position.overlayWidth);
    this.#overlay.style.height = cssPixels(position.overlayHeight);
    this.#overlay.style.setProperty(CURSOR_GUIDE_CSS_PROPERTIES.x, cssPixels(position.x));
    this.#overlay.style.setProperty(CURSOR_GUIDE_CSS_PROPERTIES.y, cssPixels(position.y));
  }

  #applyVisibility(): void {
    const visible = this.#settings.enabled && this.#hasPointer;
    this.#overlay.hidden = !visible;
    this.#overlay.setAttribute("aria-hidden", String(!visible));
  }

  #syncControls(): void {
    if (this.#controls.enabled) this.#controls.enabled.checked = this.#settings.enabled;
    if (this.#controls.geometry) this.#controls.geometry.value = this.#settings.geometry;
    if (this.#controls.style) this.#controls.style.value = this.#settings.style;
  }
}

function isFiniteRect(rect: RectLike): boolean {
  return Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cssPixels(value: number): string {
  return `${Math.round(value * 1_000) / 1_000}px`;
}
