export interface NumericTileView {
  configDigest: string;
  quality: "preview" | "refined" | "exact";
  resolution: number;
  x: number;
  y: number;
  width: number;
  height: number;
  identity: Uint16Array;
  direction: Int16Array;
  directionSupport: Uint16Array;
}

export interface ExportProvenance {
  software: string;
  exportedAt: string;
  method: string;
  schedulerPolicyVersion: number;
  comparison: unknown;
  configurations: unknown[];
  display: unknown;
  viewport: unknown;
  sequences: unknown;
}

export type DataExportFormat = "bedpe" | "csv";

export interface NumericExportContext {
  domainLength: number;
  baseResolution: number;
  viewport: { x: number; y: number; width: number; height: number };
  xName: string;
  yName: string;
}

/** Keeps worst-case CSV construction inside the 256 MiB transient-publication plan. */
export const MAX_NUMERIC_EXPORT_CELLS = 2_000_000;

/** Builds current-view renderer inputs plus complete machine-readable provenance. */
export function createNumericExport(
  tiles: readonly NumericTileView[],
  context: NumericExportContext,
  provenance: ExportProvenance,
  format: DataExportFormat = "bedpe",
): Blob {
  const visibleTiles = tiles.map((tile) => ({ tile, bounds: visibleCellBounds(tile, context) }));
  const cellCount = visibleTiles.reduce(
    (sum, { bounds }) => sum + Math.max(0, bounds.endX - bounds.startX) * Math.max(0, bounds.endY - bounds.startY),
    0,
  );
  if (cellCount > MAX_NUMERIC_EXPORT_CELLS) {
    throw new Error(
      `Numeric export contains ${cellCount.toLocaleString()} renderer cells; `
      + `the local limit is ${MAX_NUMERIC_EXPORT_CELLS.toLocaleString()}. `
      + "Zoom in or select a lower Plot resolution setting, then export again.",
    );
  }
  const chunks: BlobPart[] = format === "bedpe"
    ? [
        "# moddotplot-interactive current-view BEDPE export\n",
        `# provenance=${JSON.stringify(provenance)}\n`,
        "#chrom1\tstart1\tend1\tchrom2\tstart2\tend2\tname\tscore\tstrand1\tstrand2\tani_c\tdirection\tdirection_support\n",
      ]
    : [
        "# moddotplot-interactive current-view numeric export\n",
        `# provenance=${JSON.stringify(provenance)}\n`,
        "x_seq_id,x_start,x_end,y_seq_id,y_start,y_end,ani_c,direction,direction_support\n",
      ];
  let buffer = "";
  for (const { tile, bounds } of visibleTiles) {
    for (let row = bounds.startY; row < bounds.endY; row += 1) {
      for (let column = bounds.startX; column < bounds.endX; column += 1) {
        const offset = row * tile.width + column;
        const cellX = tile.x + column;
        const cellY = tile.y + row;
        const identity = tile.identity[offset]!;
        if (identity === 0 || identity === 0xffff) continue;
        const aniC = (identity / 10_000).toFixed(4);
        const direction = tile.direction[offset]!;
        const support = tile.directionSupport[offset]!;
        if (format === "bedpe") {
          buffer += [
            sanitizeBedName(context.xName),
            coordinate(cellX, tile.resolution, context.domainLength),
            coordinate(cellX + 1, tile.resolution, context.domainLength),
            sanitizeBedName(context.yName),
            coordinate(cellY, tile.resolution, context.domainLength),
            coordinate(cellY + 1, tile.resolution, context.domainLength),
            `ani_c=${aniC}`,
            Math.round(identity / 10),
            support > 0 ? "+" : ".",
            support > 0 ? (direction < 0 ? "-" : "+") : ".",
            aniC,
            support > 0 ? (direction / 32_767).toFixed(6) : ".",
            support,
          ].join("\t") + "\n";
        } else {
          buffer += [
            escapeCsv(context.xName),
            coordinate(cellX, tile.resolution, context.domainLength),
            coordinate(cellX + 1, tile.resolution, context.domainLength),
            escapeCsv(context.yName),
            coordinate(cellY, tile.resolution, context.domainLength),
            coordinate(cellY + 1, tile.resolution, context.domainLength),
            aniC,
            support > 0 ? (direction / 32_767).toFixed(6) : "",
            support,
          ].join(",") + "\n";
        }
        if (buffer.length >= 1_048_576) {
          chunks.push(buffer);
          buffer = "";
        }
      }
    }
  }
  if (buffer) chunks.push(buffer);
  return new Blob(chunks, {
    type: format === "bedpe" ? "text/tab-separated-values;charset=utf-8" : "text/csv;charset=utf-8",
  });
}

/** Embeds complete UTF-8 provenance in a standards-compliant PNG iTXt chunk. */
export async function embedPngProvenance(png: Blob, provenance: ExportProvenance): Promise<Blob> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  const iend = findIend(bytes);
  const keyword = new TextEncoder().encode("moddotplot-interactive");
  const text = new TextEncoder().encode(JSON.stringify(provenance));
  const data = new Uint8Array(keyword.length + 5 + text.length);
  data.set(keyword, 0);
  // keyword NUL, compression flag, compression method, language NUL, translated keyword NUL
  data.set(text, keyword.length + 5);
  const type = new TextEncoder().encode("iTXt");
  const chunk = new Uint8Array(12 + data.length);
  new DataView(chunk.buffer).setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  new DataView(chunk.buffer).setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return new Blob([bytes.subarray(0, iend), chunk, bytes.subarray(iend)], { type: "image/png" });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportBaseName(xName: string, yName: string): string {
  const safe = (value: string): string => value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "sequence";
  return `moddotplot-${safe(xName)}-vs-${safe(yName)}`;
}

function coordinate(index: number, resolution: number, domainLength: number): number {
  return Math.floor(index * domainLength / resolution);
}

function visibleCellBounds(
  tile: NumericTileView,
  context: NumericExportContext,
): { startX: number; endX: number; startY: number; endY: number } {
  const toTile = tile.resolution / context.baseResolution;
  const viewStartX = context.viewport.x * toTile;
  const viewEndX = (context.viewport.x + context.viewport.width) * toTile;
  const viewStartY = context.viewport.y * toTile;
  const viewEndY = (context.viewport.y + context.viewport.height) * toTile;
  return {
    startX: Math.max(0, Math.floor(viewStartX - tile.x)),
    endX: Math.min(tile.width, Math.ceil(viewEndX - tile.x)),
    startY: Math.max(0, Math.floor(viewStartY - tile.y)),
    endY: Math.min(tile.height, Math.ceil(viewEndY - tile.y)),
  };
}

function sanitizeBedName(value: string): string {
  return value.replace(/[\t\r\n]+/g, "_") || "sequence";
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function findIend(bytes: Uint8Array): number {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 20 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error("Image export did not produce a valid PNG");
  }
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    if (offset + 12 + length > bytes.length) break;
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === "IEND") return offset;
    offset += 12 + length;
  }
  throw new Error("PNG image is missing its terminal chunk");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
