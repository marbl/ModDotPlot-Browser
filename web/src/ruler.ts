import type { HoverDatum, ViewChange } from "./renderer";

export interface RulerAnchor {
  matrixX: number;
  matrixY: number;
  genomicX: number;
  genomicY: number;
}

export interface RulerDelta {
  x: number;
  y: number;
}

export interface RulerScreenPosition {
  x: number;
  y: number;
}

/** Anchors measurements at the center of the plot cell below the pointer. */
export function createRulerAnchor(datum: HoverDatum): RulerAnchor {
  return {
    matrixX: datum.matrixX,
    matrixY: datum.matrixY,
    genomicX: intervalMidpoint(datum.genomicXStart, datum.genomicXEnd),
    genomicY: intervalMidpoint(datum.genomicYStart, datum.genomicYEnd),
  };
}

/** Returns signed genomic distances from a fixed ruler anchor to the current cell. */
export function rulerDelta(anchor: RulerAnchor, datum: HoverDatum): RulerDelta {
  return {
    x: intervalMidpoint(datum.genomicXStart, datum.genomicXEnd) - anchor.genomicX,
    y: intervalMidpoint(datum.genomicYStart, datum.genomicYEnd) - anchor.genomicY,
  };
}

/** Maps a genomic ruler anchor back onto the current canvas viewport. */
export function rulerScreenPosition(
  anchor: RulerAnchor,
  change: ViewChange,
  width = change.pixelWidth,
  height = change.pixelHeight,
): RulerScreenPosition | null {
  if (change.view.width <= 0 || change.view.height <= 0 || width <= 0 || height <= 0) return null;
  const unitX = (anchor.matrixX - change.view.x) / change.view.width;
  const unitY = (anchor.matrixY - change.view.y) / change.view.height;
  if (unitX < 0 || unitX > 1 || unitY < 0 || unitY > 1) return null;
  return { x: unitX * width, y: (1 - unitY) * height };
}

function intervalMidpoint(start: number, end: number): number {
  return (start + end) / 2;
}
