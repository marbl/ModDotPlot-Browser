import { describe, expect, it } from "vitest";
import {
  createNumericExport,
  embedPngProvenance,
  exportBaseName,
  MAX_NUMERIC_EXPORT_CELLS,
  type ExportProvenance,
} from "../src/export";

const provenance: ExportProvenance = {
  software: "0.5.0",
  exportedAt: "2026-08-30T00:00:00.000Z",
  method: "ANI_c = C^(1/k); exact containment is the validation oracle",
  schedulerPolicyVersion: 2,
  comparison: { k: 21 },
  configurations: [{ digest: "abc", registers: 1_024 }],
  display: { minimum: 85 },
  viewport: { x: 0, y: 0, width: 2, height: 2 },
  sequences: { x: "chr1", y: "chr2" },
};

describe("reproducible export", () => {
  it("exports exact renderer inputs with machine-readable provenance", async () => {
    const blob = createNumericExport([{
      configDigest: "abc",
      quality: "refined",
      resolution: 2,
      x: 0,
      y: 0,
      width: 2,
      height: 1,
      identity: new Uint16Array([8_501, 0xffff]),
      direction: new Int16Array([12_345, -32_767]),
      directionSupport: new Uint16Array([9, 0]),
    }], 100, provenance);
    const text = await blob.text();
    expect(text).toContain(`# provenance=${JSON.stringify(provenance)}`);
    expect(text).toContain("2,0,0,0,0,0,50,0,50,8501,10000,0.8501,12345,32767,9,refined,abc");
    expect(text).toContain("65535,10000,,-32767,32767,0");
  });

  it("embeds complete provenance in a PNG iTXt chunk", async () => {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const iend = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
    const result = new Uint8Array(await (await embedPngProvenance(
      new Blob([signature, iend], { type: "image/png" }),
      provenance,
    )).arrayBuffer());
    expect(new TextDecoder().decode(result)).toContain("iTXtmoddotplot-rs");
    expect(new TextDecoder().decode(result)).toContain(JSON.stringify(provenance));
  });

  it("creates portable sequence-based names", () => {
    expect(exportBaseName("chr 1/alt", "chr2")).toBe("moddotplot-chr_1_alt-vs-chr2");
  });

  it("rejects oversized CSV work before reading tile channels", () => {
    expect(() => createNumericExport([{
      configDigest: "abc",
      quality: "preview",
      resolution: MAX_NUMERIC_EXPORT_CELLS + 1,
      x: 0,
      y: 0,
      width: MAX_NUMERIC_EXPORT_CELLS + 1,
      height: 1,
      identity: new Uint16Array(),
      direction: new Int16Array(),
      directionSupport: new Uint16Array(),
    }], 100, provenance)).toThrow("Zoom in or select a lower Plot detail setting");
  });
});
