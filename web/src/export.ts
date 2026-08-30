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

/** Keeps worst-case CSV construction inside the 256 MiB transient-publication plan. */
export const MAX_NUMERIC_EXPORT_CELLS = 2_000_000;

/** Builds the exact fixed-point renderer inputs plus complete machine-readable provenance. */
export function createNumericExport(
  tiles: readonly NumericTileView[],
  domainLength: number,
  provenance: ExportProvenance,
): Blob {
  const cellCount = tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
  if (cellCount > MAX_NUMERIC_EXPORT_CELLS) {
    throw new Error(
      `Numeric export contains ${cellCount.toLocaleString()} renderer cells; `
      + `the local limit is ${MAX_NUMERIC_EXPORT_CELLS.toLocaleString()}. `
      + "Zoom in or select a lower Plot detail setting, then export again.",
    );
  }
  const chunks: BlobPart[] = [
    "# moddotplot-rs numeric tile export\n",
    `# provenance=${JSON.stringify(provenance)}\n`,
    "resolution,tile_x,tile_y,cell_x,cell_y,x_start,x_end,y_start,y_end,identity_fixed,identity_scale,ani_c,direction_fixed,direction_scale,direction_support,quality,config_digest\n",
  ];
  let buffer = "";
  for (const tile of tiles) {
    for (let row = 0; row < tile.height; row += 1) {
      for (let column = 0; column < tile.width; column += 1) {
        const offset = row * tile.width + column;
        const cellX = tile.x + column;
        const cellY = tile.y + row;
        const identity = tile.identity[offset]!;
        const aniC = identity === 0xffff ? "" : (identity / 10_000).toFixed(4);
        buffer += [
          tile.resolution,
          tile.x,
          tile.y,
          cellX,
          cellY,
          coordinate(cellX, tile.resolution, domainLength),
          coordinate(cellX + 1, tile.resolution, domainLength),
          coordinate(cellY, tile.resolution, domainLength),
          coordinate(cellY + 1, tile.resolution, domainLength),
          identity,
          10_000,
          aniC,
          tile.direction[offset]!,
          32_767,
          tile.directionSupport[offset]!,
          tile.quality,
          tile.configDigest,
        ].join(",") + "\n";
        if (buffer.length >= 1_048_576) {
          chunks.push(buffer);
          buffer = "";
        }
      }
    }
  }
  if (buffer) chunks.push(buffer);
  return new Blob(chunks, { type: "text/csv;charset=utf-8" });
}

/** Embeds complete UTF-8 provenance in a standards-compliant PNG iTXt chunk. */
export async function embedPngProvenance(png: Blob, provenance: ExportProvenance): Promise<Blob> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  const iend = findIend(bytes);
  const keyword = new TextEncoder().encode("moddotplot-rs");
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
