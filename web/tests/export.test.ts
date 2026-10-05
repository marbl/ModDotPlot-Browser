import { describe, expect, it } from "vitest";
import {
  createNumericExport,
  embedPngProvenance,
  exportBaseName,
  MAX_NUMERIC_EXPORT_CELLS,
  type ExportProvenance,
} from "../src/export";

const context = {
  domainLength: 100,
  baseResolution: 2,
  viewport: { x: 0, y: 0, width: 2, height: 2 },
  xName: "chr1",
  yName: "chr2",
};

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
  it("exports a compact scientific CSV with machine-readable provenance", async () => {
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
    }], context, provenance, "csv");
    const text = await blob.text();
    expect(text).toContain(`# provenance=${JSON.stringify(provenance)}`);
    expect(text).toContain("x_seq_id,x_start,x_end,y_seq_id,y_start,y_end,ani_c,direction,direction_support");
    expect(text).toContain("chr1,0,50,chr2,0,50,0.8501,0.376751,9");
    expect(text).not.toContain("65535");
    expect(text).not.toContain("identity_fixed");
  });

  it("exports visible non-missing cells as BEDPE by default", async () => {
    const blob = createNumericExport([{
      configDigest: "abc",
      quality: "refined",
      resolution: 2,
      x: 0,
      y: 0,
      width: 2,
      height: 1,
      identity: new Uint16Array([8_501, 0xffff]),
      direction: new Int16Array([-16_384, 0]),
      directionSupport: new Uint16Array([9, 0]),
    }], { ...context, viewport: { x: 0, y: 0, width: 1, height: 1 } }, provenance);
    const text = await blob.text();
    expect(text).toContain("#chrom1\tstart1\tend1\tchrom2");
    expect(text).toContain("chr1\t0\t50\tchr2\t0\t50\tani_c=0.8501\t850\t+\t-\t0.8501");
    expect(text).not.toContain("quality\tconfig_digest");
    expect(text).not.toContain("\trefined\tabc");
    expect(text).not.toContain("65535");
  });

  it("clips CSV cells to a panned viewport", async () => {
    const blob = createNumericExport([{
      configDigest: "abc",
      quality: "exact",
      resolution: 3,
      x: 0,
      y: 0,
      width: 3,
      height: 1,
      identity: new Uint16Array([8_000, 9_000, 10_000]),
      direction: new Int16Array([1, 2, 3]),
      directionSupport: new Uint16Array([4, 5, 6]),
    }], {
      ...context,
      baseResolution: 3,
      viewport: { x: 1, y: 0, width: 1, height: 1 },
    }, provenance, "csv");
    const rows = (await blob.text()).split("\n").filter((row) => /^chr1,/.test(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe("chr1,33,66,chr2,0,33,0.9000,0.000061,5");
  });

  it("omits zero-valued cells from BEDPE and CSV", async () => {
    const tile = {
      configDigest: "abc",
      quality: "preview" as const,
      resolution: 2,
      x: 0,
      y: 0,
      width: 2,
      height: 1,
      identity: new Uint16Array([0, 9_000]),
      direction: new Int16Array([0, 1]),
      directionSupport: new Uint16Array([0, 2]),
    };
    for (const format of ["bedpe", "csv"] as const) {
      const rows = (await createNumericExport([tile], context, provenance, format).text())
        .split("\n")
        .filter((row) => row && !row.startsWith("#") && !row.startsWith("x_seq_id,"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("0.9000");
    }
  });

  it("quotes FASTA identifiers when CSV syntax requires it", async () => {
    const tile = {
      configDigest: "abc",
      quality: "refined" as const,
      resolution: 1,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      identity: new Uint16Array([9_000]),
      direction: new Int16Array([0]),
      directionSupport: new Uint16Array([0]),
    };
    const text = await createNumericExport(
      [tile],
      { ...context, baseResolution: 1, viewport: { x: 0, y: 0, width: 1, height: 1 }, xName: "chr,1", yName: 'chr"2' },
      provenance,
      "csv",
    ).text();
    expect(text).toContain('"chr,1",0,100,"chr""2",0,100,0.9000,,0');
  });

  it("embeds complete provenance in a PNG iTXt chunk", async () => {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const iend = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
    const result = new Uint8Array(await (await embedPngProvenance(
      new Blob([signature, iend], { type: "image/png" }),
      provenance,
    )).arrayBuffer());
    expect(new TextDecoder().decode(result)).toContain("iTXtmoddotplot-interactive");
    expect(new TextDecoder().decode(result)).toContain(JSON.stringify(provenance));
  });

  it("creates portable sequence-based names", () => {
    expect(exportBaseName("chr 1/alt", "chr2")).toBe("moddotplot-chr_1_alt-vs-chr2");
  });

  it("does not reject sparse views merely because their renderer bounds exceed the row limit", async () => {
    const width = MAX_NUMERIC_EXPORT_CELLS + 1;
    const identity = new Uint16Array(width);
    identity[width - 1] = 9_000;
    const result = createNumericExport([{
      configDigest: "abc",
      quality: "preview",
      resolution: width,
      x: 0,
      y: 0,
      width,
      height: 1,
      identity,
      direction: new Int16Array(width),
      directionSupport: new Uint16Array(width),
    }], {
      ...context,
      domainLength: width,
      baseResolution: width,
      viewport: { x: 0, y: 0, width, height: 1 },
    }, provenance, "csv");
    expect(await result.text()).toContain(`chr1,${width - 1},${width},chr2,0,1,0.9000,,0`);
  });

  it("rejects only when the number of nonzero export rows exceeds the safety limit", () => {
    const width = MAX_NUMERIC_EXPORT_CELLS + 1;
    expect(() => createNumericExport([{
      configDigest: "abc",
      quality: "preview",
      resolution: width,
      x: 0,
      y: 0,
      width,
      height: 1,
      identity: new Uint16Array(width).fill(9_000),
      direction: new Int16Array(width),
      directionSupport: new Uint16Array(width),
    }], {
      ...context,
      domainLength: width,
      baseResolution: width,
      viewport: { x: 0, y: 0, width, height: 1 },
    }, provenance, "csv")).toThrow("Zoom in or select a lower Plot resolution setting");
  });
});
