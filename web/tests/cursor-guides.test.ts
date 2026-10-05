import { describe, expect, it } from "vitest";
import {
  CURSOR_GUIDE_CSS_PROPERTIES,
  CursorGuideController,
  DEFAULT_CURSOR_GUIDE_SETTINGS,
  normalizeCursorGuideSettings,
  resolveCursorGuidePosition,
  type RectLike,
} from "../src/cursor-guides";

class FakeStyle {
  left = "";
  top = "";
  width = "";
  height = "";
  pointerEvents = "";
  readonly #properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.#properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.#properties.get(name) ?? "";
  }
}

class FakeElement extends EventTarget {
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  hidden = false;
  checked = false;
  value = "";
  readonly attributes = new Map<string, string>();
  rect: RectLike;

  constructor(rect: RectLike) {
    super();
    this.rect = rect;
  }

  getBoundingClientRect(): DOMRect {
    return this.rect as DOMRect;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

const frameRect: RectLike = {
  left: 80,
  top: 30,
  right: 340,
  bottom: 190,
  width: 260,
  height: 160,
};

const canvasRect: RectLike = {
  left: 100,
  top: 50,
  right: 300,
  bottom: 150,
  width: 200,
  height: 100,
};

function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function asCanvas(element: FakeElement): HTMLCanvasElement {
  return element as unknown as HTMLCanvasElement;
}

function asInput(element: FakeElement): HTMLInputElement {
  return element as unknown as HTMLInputElement;
}

function asSelect(element: FakeElement): HTMLSelectElement {
  return element as unknown as HTMLSelectElement;
}

describe("cursor guide settings", () => {
  it("defaults to visible dotted horizontal and vertical axes", () => {
    expect(DEFAULT_CURSOR_GUIDE_SETTINGS).toEqual({
      enabled: true,
      geometry: "axes",
      style: "dotted",
    });
    expect(normalizeCursorGuideSettings()).toEqual(DEFAULT_CURSOR_GUIDE_SETTINGS);
  });

  it("keeps valid choices and rejects malformed persisted values", () => {
    expect(normalizeCursorGuideSettings({
      enabled: false,
      geometry: "diagonals",
      style: "solid",
    })).toEqual({ enabled: false, geometry: "diagonals", style: "solid" });
    expect(normalizeCursorGuideSettings({
      geometry: "curves" as "axes",
      style: "double" as "solid",
    })).toEqual(DEFAULT_CURSOR_GUIDE_SETTINGS);
  });
});

describe("cursor guide positioning", () => {
  it("maps viewport coordinates into the canvas overlay within its frame", () => {
    expect(resolveCursorGuidePosition(175, 80, canvasRect, frameRect)).toEqual({
      x: 75,
      y: 30,
      overlayLeft: 20,
      overlayTop: 20,
      overlayWidth: 200,
      overlayHeight: 100,
    });
  });

  it("includes exact plot edges and hides outside or collapsed layouts", () => {
    expect(resolveCursorGuidePosition(300, 150, canvasRect, frameRect)?.x).toBe(200);
    expect(resolveCursorGuidePosition(99.9, 80, canvasRect, frameRect)).toBeNull();
    expect(resolveCursorGuidePosition(175, 151, canvasRect, frameRect)).toBeNull();
    expect(resolveCursorGuidePosition(175, 80, { ...canvasRect, width: 0 }, frameRect)).toBeNull();
    expect(resolveCursorGuidePosition(Number.NaN, 80, canvasRect, frameRect)).toBeNull();
  });
});

describe("cursor guide controller", () => {
  it("updates overlay position, visibility, geometry, and line style", () => {
    const frame = new FakeElement(frameRect);
    const canvas = new FakeElement(canvasRect);
    const overlay = new FakeElement(frameRect);
    const controller = new CursorGuideController({
      frame: asElement(frame),
      canvas: asCanvas(canvas),
      overlay: asElement(overlay),
    });

    expect(overlay.hidden).toBe(true);
    expect(overlay.dataset.guideGeometry).toBe("axes");
    expect(overlay.style.getPropertyValue(CURSOR_GUIDE_CSS_PROPERTIES.firstAngle)).toBe("0deg");
    expect(controller.moveToClientPoint(175.1254, 80.0004)).toBe(true);
    expect(overlay.hidden).toBe(false);
    expect(overlay.style.left).toBe("20px");
    expect(overlay.style.width).toBe("200px");
    expect(overlay.style.getPropertyValue(CURSOR_GUIDE_CSS_PROPERTIES.x)).toBe("75.125px");
    expect(overlay.style.getPropertyValue(CURSOR_GUIDE_CSS_PROPERTIES.y)).toBe("30px");

    controller.setGeometry("diagonals");
    controller.setLineStyle("dashed");
    expect(overlay.dataset.guideGeometry).toBe("diagonals");
    expect(overlay.dataset.guideStyle).toBe("dashed");
    expect(overlay.style.getPropertyValue(CURSOR_GUIDE_CSS_PROPERTIES.firstAngle)).toBe("45deg");
    expect(overlay.style.getPropertyValue(CURSOR_GUIDE_CSS_PROPERTIES.secondAngle)).toBe("-45deg");

    controller.setEnabled(false);
    expect(overlay.hidden).toBe(true);
    controller.setEnabled(true);
    expect(overlay.hidden).toBe(false);
    expect(controller.moveToClientPoint(90, 80)).toBe(false);
    expect(overlay.hidden).toBe(true);
    controller.destroy();
  });

  it("binds optional advanced controls and detaches pointer listeners", () => {
    const frame = new FakeElement(frameRect);
    const canvas = new FakeElement(canvasRect);
    const overlay = new FakeElement(frameRect);
    const enabled = new FakeElement(frameRect);
    const geometry = new FakeElement(frameRect);
    const style = new FakeElement(frameRect);
    enabled.checked = true;
    geometry.value = "axes";
    style.value = "dotted";
    const controller = new CursorGuideController({
      frame: asElement(frame),
      canvas: asCanvas(canvas),
      overlay: asElement(overlay),
      controls: {
        enabled: asInput(enabled),
        geometry: asSelect(geometry),
        style: asSelect(style),
      },
    });

    geometry.value = "diagonals";
    geometry.dispatchEvent(new Event("change"));
    style.value = "solid";
    style.dispatchEvent(new Event("change"));
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change"));
    expect(controller.settings).toEqual({ enabled: false, geometry: "diagonals", style: "solid" });

    enabled.checked = true;
    enabled.dispatchEvent(new Event("change"));
    const move = new Event("pointermove") as PointerEvent;
    Object.defineProperties(move, {
      clientX: { value: 150 },
      clientY: { value: 75 },
    });
    canvas.dispatchEvent(move);
    expect(overlay.hidden).toBe(false);
    canvas.dispatchEvent(new Event("pointerleave"));
    expect(overlay.hidden).toBe(true);

    controller.destroy();
    canvas.dispatchEvent(move);
    expect(overlay.hidden).toBe(true);
  });
});
