export function formatBases(value: number): string {
  if (value >= 1_000_000_000) return `${trim(value / 1_000_000_000)} Gb`;
  if (value >= 1_000_000) return `${trim(value / 1_000_000)} Mb`;
  if (value >= 1_000) return `${trim(value / 1_000)} kb`;
  return `${value} bp`;
}

/** Formats one representative genomic span for a scientific matrix cell. */
export function formatPlotWindowSize(domainLength: number, resolution: number): string {
  if (!Number.isFinite(domainLength) || !Number.isFinite(resolution)) return "—";
  const domain = Math.floor(domainLength);
  if (domain < 1 || resolution < 1) return "—";
  const cells = Math.min(domain, Math.max(1, Math.floor(resolution)));
  const windowSize = domain / cells;
  if (Number.isInteger(windowSize)) return `${formatBases(windowSize)} per cell`;
  return `≈${Math.round(windowSize).toLocaleString("en-US")} bp per cell`;
}

export function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${trim(value / 1024 ** 3)} GiB`;
  if (value >= 1024 ** 2) return `${trim(value / 1024 ** 2)} MiB`;
  if (value >= 1024) return `${trim(value / 1024)} KiB`;
  return `${value} B`;
}

export function formatCoordinate(value: number): string {
  return Math.max(0, Math.floor(value) + 1).toLocaleString("en-US");
}

/** Labels zero-based axis boundaries without turning round milestones into `n + 1`. */
export function formatAxisCoordinate(value: number): string {
  return Math.max(1, Math.floor(value)).toLocaleString("en-US");
}

/** Formats a zero-based half-open interval as one-based inclusive coordinates. */
export function formatInterval(start: number, end: number): string {
  const first = Math.max(0, Math.floor(start) + 1);
  const last = Math.max(first, Math.ceil(end));
  return first === last
    ? first.toLocaleString("en-US")
    : `${first.toLocaleString("en-US")}–${last.toLocaleString("en-US")}`;
}

function trim(value: number): string {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$|(?<=\.[0-9])0$/, "");
}
