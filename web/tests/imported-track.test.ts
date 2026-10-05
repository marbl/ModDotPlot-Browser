import { describe, expect, it } from "vitest";
import {
  annotationAdmissionError,
  assignFeatureLanes,
  gffFeatureColor,
  inferFeatureFormat,
  parseItemRgb,
  resolveTrackSequenceIdentifier,
  sequenceIdentifierMatch,
  trackCollectionAxisEligible,
  trackAxisEligible,
  type ImportedFeature,
} from "../src/imported-track-types";
import { midpointSwapDirection } from "../src/imported-track";

describe("imported feature tracks", () => {
  it("enforces the documented annotation admission envelope", () => {
    expect(annotationAdmissionError(512 * 1024 * 1024, 1_000_000)).toBeNull();
    expect(annotationAdmissionError(512 * 1024 * 1024 + 1, 1)).toContain("bytes");
    expect(annotationAdmissionError(1, 1_000_001)).toContain("matching records");
  });

  it("recognizes supported text formats and UCSC itemRgb colors", () => {
    expect(inferFeatureFormat("regions.bed")).toBe("bed");
    expect(inferFeatureFormat("regions.bed.gz")).toBe("bed");
    expect(inferFeatureFormat("regions.bed.bgz")).toBe("bed");
    expect(inferFeatureFormat("genes.gff3")).toBe("gff3");
    expect(inferFeatureFormat("genes.gff3.gz")).toBe("gff3");
    expect(inferFeatureFormat("genes.gff3.bgzf")).toBe("gff3");
    expect(inferFeatureFormat("genes.gtf")).toBe("gtf");
    expect(inferFeatureFormat("genes.gtf.gz")).toBe("gtf");
    expect(inferFeatureFormat("features.txt", "chr1\t0\t10")).toBe("bed");
    expect(parseItemRgb("151,112,195")).toBe("rgb(151, 112, 195)");
    expect(parseItemRgb("300,2,1")).toBeNull();
  });

  it("uses only conservative sequence aliases", () => {
    expect(sequenceIdentifierMatch("chr1", "chr1")).toBe("exact");
    expect(sequenceIdentifierMatch("chr1", "1")).toBe("alias");
    expect(sequenceIdentifierMatch("MT", "chrM")).toBe("alias");
    expect(sequenceIdentifierMatch("chr10", "chr1")).toBeNull();
  });

  it("resolves batch identifiers to exactly one sequence with exact matches preferred", () => {
    const candidates = [
      { axis: "x" as const, index: 0, name: "chr1", length: 100 },
      { axis: "y" as const, index: 1, name: "1", length: 100 },
      { axis: "y" as const, index: 2, name: "MT", length: 100 },
      { axis: "y" as const, index: 3, name: "M", length: 100 },
    ];
    expect(resolveTrackSequenceIdentifier("chr1", candidates)).toMatchObject({
      kind: "match",
      candidate: { index: 0 },
      matchKind: "exact",
    });
    expect(resolveTrackSequenceIdentifier("chr2", [
      { axis: "x", index: 4, name: "2", length: 100 },
    ])).toMatchObject({ kind: "match", candidate: { index: 4 }, matchKind: "alias" });
    expect(resolveTrackSequenceIdentifier("chrMT", candidates)).toMatchObject({
      kind: "ambiguous",
      candidates: [{ index: 2 }, { index: 3 }],
    });
    expect(resolveTrackSequenceIdentifier("unplaced", candidates)).toEqual({ kind: "none" });
  });

  it("assigns the requested GFF gene-category colors", () => {
    expect(gffFeatureColor("gene", { gene_biotype: "protein_coding" })).toBe("#173f73");
    expect(gffFeatureColor("pseudogene", {})).toBe("#4f78a8");
    expect(gffFeatureColor("lnc_RNA", {})).toBe("#397a4c");
    expect(gffFeatureColor("gene", {})).toBe("#45464a");
  });

  it("associates tracks with sequences and permits both axes only in self comparisons", () => {
    expect(trackAxisEligible(2, "x", 2, 5)).toBe(true);
    expect(trackAxisEligible(2, "y", 2, 5)).toBe(false);
    expect(trackAxisEligible(2, "x", 2, 2)).toBe(true);
    expect(trackAxisEligible(2, "y", 2, 2)).toBe(true);
  });

  it("applies one logical track to every matching sequence selected on either axis", () => {
    const matchingSequences = new Set([2, 4, 7]);
    expect(trackCollectionAxisEligible(matchingSequences, "x", 4, 9)).toBe(true);
    expect(trackCollectionAxisEligible(matchingSequences, "y", 4, 7)).toBe(true);
    expect(trackCollectionAxisEligible(matchingSequences, "y", 4, 9)).toBe(false);
  });

  it("packs overlapping features into stable greedy lanes", () => {
    const features = [feature("c", 20, 40), feature("a", 0, 30), feature("b", 10, 15)];
    expect(assignFeatureLanes(features)).toBe(1);
    expect(features.map(({ id, lane }) => [id, lane])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 1],
    ]);
  });

  it("reorders only beyond an adjacent track midpoint", () => {
    expect(midpointSwapDirection(19.9, 20, 40)).toBe(-1);
    expect(midpointSwapDirection(20, 20, 40)).toBe(0);
    expect(midpointSwapDirection(39.9, 20, 40)).toBe(0);
    expect(midpointSwapDirection(40, 20, 40)).toBe(0);
    expect(midpointSwapDirection(40.1, 20, 40)).toBe(1);

    // After a downward swap, the same pointer coordinate is between the new neighbors
    // and therefore cannot immediately swap the track back.
    expect(midpointSwapDirection(40.1, 20, 60)).toBe(0);
  });
});

function feature(id: string, start: number, end: number): ImportedFeature {
  return {
    id,
    name: id,
    type: "BED",
    start,
    end,
    strand: ".",
    color: "#000",
    blocks: [start, end],
    lane: 0,
    details: [],
  };
}
