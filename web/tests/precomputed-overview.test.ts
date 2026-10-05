import { describe, expect, it } from "vitest";
import {
  PRECOMPUTED_OVERVIEW_SCHEMA_VERSION,
  decodePrecomputedOverview,
  decodePrecomputedOverviewGzip,
  encodePrecomputedOverview,
  type PrecomputedOverviewArtifact,
} from "../src/precomputed-overview";

const CONFIG_IDENTITY = "01001501000000000000000000040000000000000e20020a010100000000000000009a9999999999e93fae47e17a14aeef3fffff1027";
const CONFIG_DIGEST = "bc5c5131ad1c9a20";

function fixture(): PrecomputedOverviewArtifact {
  const fastaIndexText = "Chr1\t4\t6\t4\t5\n";
  return {
    schemaVersion: PRECOMPUTED_OVERVIEW_SCHEMA_VERSION,
    generator: "test-generator@1",
    sourceAssets: [
      { role: "fasta", fileName: "input.fa", byteLength: 11, sha256: "1".repeat(64) },
      {
        role: "fai",
        fileName: "input.fa.fai",
        byteLength: new TextEncoder().encode(fastaIndexText).byteLength,
        sha256: "2".repeat(64),
      },
      { role: "annotation", fileName: "input.gff3", byteLength: 8, sha256: "3".repeat(64) },
    ],
    fastaIndexText,
    sequences: [{ index: 0, name: "Chr1", description: "", length: 4, sourceFile: "input.fa" }],
    comparison: { xIndex: 0, yIndex: 0, resolution: 2, k: 21, configDigest: CONFIG_DIGEST },
    configurations: [{
      version: 1,
      identity: CONFIG_IDENTITY,
      digest: CONFIG_DIGEST,
      hashAlgorithm: "nthash2",
      hashSeed: "0",
      estimator: "verified_winners",
      k: 21,
      registerCount: 1_024,
      hllPrecision: 10,
      bBits: 14,
      verificationBits: 32,
      identityScale: 10_000,
      missingIdentity: 65_535,
    }],
    tiles: [{
      quality: "refined",
      configDigest: CONFIG_DIGEST,
      resolution: 2,
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      identity: new Uint16Array([10_000, 9_900, 9_800, 10_000]),
      direction: new Int16Array([0, -12, 12, 0]),
      directionSupport: new Uint16Array([40, 30, 30, 40]),
    }],
  };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const compressed = new Blob([owned.buffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

describe("precomputed overview artifact codec", () => {
  it("round-trips all provenance and scientific tile channels deterministically", () => {
    const encoded = encodePrecomputedOverview(fixture());
    const decoded = decodePrecomputedOverview(encoded);

    expect(decoded.generator).toBe("test-generator@1");
    expect(decoded.fastaIndexText).toBe("Chr1\t4\t6\t4\t5\n");
    expect(decoded.sourceAssets.map(({ role }) => role)).toEqual(["fasta", "fai", "annotation"]);
    expect(decoded.sequences).toEqual(fixture().sequences);
    expect(decoded.configurations[0]).toMatchObject({
      identity: CONFIG_IDENTITY,
      digest: CONFIG_DIGEST,
      registerCount: 1_024,
    });
    expect([...decoded.tiles[0]!.identity]).toEqual([10_000, 9_900, 9_800, 10_000]);
    expect([...decoded.tiles[0]!.direction]).toEqual([0, -12, 12, 0]);
    expect([...decoded.tiles[0]!.directionSupport]).toEqual([40, 30, 30, 40]);
    expect(encodePrecomputedOverview(decoded)).toEqual(encoded);
  });

  it("decodes the gzip transport wrapper through the same validation boundary", async () => {
    const artifact = fixture();
    const decoded = await decodePrecomputedOverviewGzip(await gzip(encodePrecomputedOverview(artifact)));
    expect(decoded.comparison).toEqual(artifact.comparison);
    expect(decoded.tiles[0]!.identity).toEqual(artifact.tiles[0]!.identity);
  });

  it("rejects invalid magic, schema versions, truncation, and trailing bytes", () => {
    const encoded = encodePrecomputedOverview(fixture());
    const badMagic = encoded.slice();
    badMagic[0] = 0;
    expect(() => decodePrecomputedOverview(badMagic)).toThrow(/magic/u);

    const badSchema = encoded.slice();
    new DataView(badSchema.buffer).setUint32(8, 99, true);
    expect(() => decodePrecomputedOverview(badSchema)).toThrow(/schema version 99/u);
    expect(() => decodePrecomputedOverview(encoded.subarray(0, encoded.length - 1))).toThrow(/truncated/u);

    const trailing = new Uint8Array(encoded.length + 1);
    trailing.set(encoded);
    expect(() => decodePrecomputedOverview(trailing)).toThrow(/trailing/u);
  });

  it("rejects malformed gzip before attempting artifact decoding", async () => {
    await expect(decodePrecomputedOverviewGzip(new Uint8Array([1, 2, 3, 4])))
      .rejects.toThrow(/gzip data is invalid/u);
  });

  it("binds source hashes and FAI bytes to validated sequence metadata", () => {
    const badHash = fixture();
    badHash.sourceAssets[0]!.sha256 = "not-a-sha";
    expect(() => encodePrecomputedOverview(badHash)).toThrow(/SHA-256/u);

    const wrongFaiLength = fixture();
    wrongFaiLength.sourceAssets[1]!.byteLength += 1;
    expect(() => encodePrecomputedOverview(wrongFaiLength)).toThrow(/FAI text/u);

    const wrongSequence = fixture();
    wrongSequence.sequences[0]!.length = 5;
    expect(() => encodePrecomputedOverview(wrongSequence)).toThrow(/disagrees with its FAI/u);
  });

  it("verifies the full canonical scientific identity and its shorter digest", () => {
    const badDigest = fixture();
    badDigest.configurations[0]!.digest = "0000000000000000";
    badDigest.comparison.configDigest = "0000000000000000";
    badDigest.tiles[0]!.configDigest = "0000000000000000";
    expect(() => encodePrecomputedOverview(badDigest)).toThrow(/digest does not match/u);

    const badIdentityMetadata = fixture();
    badIdentityMetadata.configurations[0]!.registerCount = 512;
    expect(() => encodePrecomputedOverview(badIdentityMetadata)).toThrow(/metadata disagrees/u);
  });

  it("rejects out-of-bounds, malformed, overlapping, and incomplete tile coverage", () => {
    const badLength = fixture();
    badLength.tiles[0]!.identity = new Uint16Array(3);
    expect(() => encodePrecomputedOverview(badLength)).toThrow(/channels/u);

    const outOfBounds = fixture();
    outOfBounds.tiles[0]!.x = 1;
    expect(() => encodePrecomputedOverview(outOfBounds)).toThrow(/outside/u);

    const incomplete = fixture();
    incomplete.tiles[0]!.width = 1;
    incomplete.tiles[0]!.identity = new Uint16Array(2);
    incomplete.tiles[0]!.direction = new Int16Array(2);
    incomplete.tiles[0]!.directionSupport = new Uint16Array(2);
    expect(() => encodePrecomputedOverview(incomplete)).toThrow(/fully cover/u);

    const overlapping = fixture();
    overlapping.tiles = [overlapping.tiles[0]!, {
      ...overlapping.tiles[0]!,
    }];
    expect(() => encodePrecomputedOverview(overlapping)).toThrow(/overlap|row-major/u);
  });
});
