export interface ViewportState {
  x: number;
  y: number;
  width: number;
  height: number;
  domain: number;
  minSize: number;
}

export function initialViewport(domain: number, minSize = 1): ViewportState {
  return { x: 0, y: 0, width: domain, height: domain, domain, minSize };
}

export function zoomAt(
  view: ViewportState,
  factor: number,
  unitX: number,
  unitY: number,
): ViewportState {
  const clampedFactor = Math.max(0.05, Math.min(20, factor));
  const newWidth = Math.max(view.minSize, Math.min(view.domain, view.width * clampedFactor));
  const newHeight = Math.max(view.minSize, Math.min(view.domain, view.height * clampedFactor));
  const anchorX = view.x + unitX * view.width;
  const anchorY = view.y + unitY * view.height;
  return clampViewport({
    ...view,
    x: anchorX - unitX * newWidth,
    y: anchorY - unitY * newHeight,
    width: newWidth,
    height: newHeight,
  });
}

export function panBy(view: ViewportState, deltaX: number, deltaY: number): ViewportState {
  return clampViewport({ ...view, x: view.x + deltaX, y: view.y + deltaY });
}

/** Preserves the same normalized genomic region when the overview resolution changes. */
export function remapViewportDomain(
  view: ViewportState,
  domain: number,
  minSize = 1,
): ViewportState {
  const scale = domain / Math.max(Number.EPSILON, view.domain);
  return clampViewport({
    x: view.x * scale,
    y: view.y * scale,
    width: view.width * scale,
    height: view.height * scale,
    domain,
    minSize,
  });
}

export function clampViewport(view: ViewportState): ViewportState {
  const width = Math.max(view.minSize, Math.min(view.domain, view.width));
  const height = Math.max(view.minSize, Math.min(view.domain, view.height));
  return {
    ...view,
    width,
    height,
    x: Math.max(0, Math.min(view.domain - width, view.x)),
    y: Math.max(0, Math.min(view.domain - height, view.y)),
  };
}
