export interface ZipEntry {
  name: string;
  data: Blob;
}

const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP32_MAX = 0xffff_ffff;
const DOS_EPOCH_DATE = 0x0021;

/**
 * Builds a portable ZIP archive without copying entry payloads into one large
 * JavaScript buffer. Entries use ZIP's store method: the archive bundles the files
 * into one browser download while leaving already-compressed or very large exports
 * untouched.
 */
export async function createZipArchive(entries: readonly ZipEntry[]): Promise<Blob> {
  if (entries.length === 0) throw new Error("A ZIP archive needs at least one file.");
  if (entries.length > 0xffff) throw new Error("ZIP archives support at most 65,535 files.");

  const encoder = new TextEncoder();
  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let localOffset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const name = safeEntryName(entry.name);
    const encodedName = encoder.encode(name);
    if (encodedName.byteLength > 0xffff) throw new Error(`ZIP filename is too long: ${name}`);
    if (entry.data.size > ZIP32_MAX) throw new Error(`ZIP entry exceeds the 4 GiB limit: ${name}`);
    if (localOffset > ZIP32_MAX) throw new Error("ZIP archive exceeds the 4 GiB limit.");

    const checksum = await crc32(entry.data);
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, ZIP_VERSION, true);
    localView.setUint16(6, UTF8_FLAG, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, DOS_EPOCH_DATE, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.data.size, true);
    localView.setUint32(22, entry.data.size, true);
    localView.setUint16(26, encodedName.byteLength, true);
    localView.setUint16(28, 0, true);
    localParts.push(localHeader, encodedName, entry.data);

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, ZIP_VERSION, true);
    centralView.setUint16(6, ZIP_VERSION, true);
    centralView.setUint16(8, UTF8_FLAG, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, DOS_EPOCH_DATE, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.data.size, true);
    centralView.setUint32(24, entry.data.size, true);
    centralView.setUint16(28, encodedName.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralParts.push(centralHeader, encodedName);

    localOffset += localHeader.byteLength + encodedName.byteLength + entry.data.size;
    centralSize += centralHeader.byteLength + encodedName.byteLength;
  }

  if (localOffset + centralSize + 22 > ZIP32_MAX) {
    throw new Error("ZIP archive exceeds the 4 GiB limit.");
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);
  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function safeEntryName(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe ZIP filename: ${name}`);
  }
  return normalized;
}

async function crc32(blob: Blob): Promise<number> {
  const reader = blob.stream().getReader();
  let crc = 0xffff_ffff;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const byte of value) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
      }
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
