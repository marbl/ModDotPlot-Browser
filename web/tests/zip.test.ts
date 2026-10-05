import { describe, expect, it } from "vitest";
import { createZipArchive } from "../src/zip";

describe("command export ZIP archive", () => {
  it("stores both named files in a standards-compatible ZIP", async () => {
    const archive = await createZipArchive([
      { name: "example.bedpe", data: new Blob(["bedpe rows\n"]) },
      { name: "example.config.json", data: new Blob(["{\"load\":[\"./example.bedpe\"]}\n"]) },
    ]);

    expect(archive.type).toBe("application/zip");
    const entries = readStoredZip(await archive.arrayBuffer());
    expect(entries).toEqual(new Map([
      ["example.bedpe", "bedpe rows\n"],
      ["example.config.json", "{\"load\":[\"./example.bedpe\"]}\n"],
    ]));
  });

  it("rejects parent traversal filenames", async () => {
    await expect(createZipArchive([{ name: "../escape.txt", data: new Blob(["no"]) }]))
      .rejects.toThrow("Unsafe ZIP filename");
  });
});

function readStoredZip(buffer: ArrayBuffer): Map<string, string> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    expect(view.getUint16(offset + 8, true)).toBe(0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  return entries;
}
