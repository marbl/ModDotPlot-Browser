import { describe, expect, it } from "vitest";
import {
  assignFeatureLanes,
  gffFeatureColor,
  inferFeatureFormat,
  parseItemRgb,
  sequenceIdentifierMatch,
  trackAxisEligible,
  type ImportedFeature,
} from "../src/imported-track-types";

describe("imported feature tracks", () => {
  it("recognizes supported text formats and UCSC itemRgb colors", () => {
    expect(inferFeatureFormat("regions.bed")).toBe("bed");
    expect(inferFeatureFormat("regions.bed.gz")).toBe("bed");
    expect(inferFeatureFormat("genes.gff3")).toBe("gff3");
    expect(inferFeatureFormat("genes.gff3.gz")).toBe("gff3");
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

  it("packs overlapping features into stable greedy lanes", () => {
    const features = [feature("c", 20, 40), feature("a", 0, 30), feature("b", 10, 15)];
    expect(assignFeatureLanes(features)).toBe(1);
    expect(features.map(({ id, lane }) => [id, lane])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 1],
    ]);
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
