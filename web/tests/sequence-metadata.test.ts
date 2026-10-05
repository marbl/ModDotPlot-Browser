import { describe, expect, it } from "vitest";
import {
  assignSequenceSelectionIds,
  fastaFileStem,
  sequenceAxisLabel,
} from "../src/sequence-metadata";

describe("sequence presentation metadata", () => {
  it("uses source-qualified identifiers and resolves remaining collisions", () => {
    const sequences = assignSequenceSelectionIds([
      { index: 0, name: "chr1", description: "human", length: 10, sourceFile: "human.fa.gz" },
      { index: 1, name: "chr1", description: "gorilla", length: 11, sourceFile: "gorilla.fasta" },
      { index: 2, name: "chr1", description: "duplicate", length: 12, sourceFile: "human.fa.gz" },
    ]);
    expect(sequences.map((sequence) => sequence.selectionId)).toEqual([
      "chr1_human",
      "chr1_gorilla",
      "chr1_human-2",
    ]);
  });

  it("keeps descriptions on axes but out of identifiers", () => {
    expect(sequenceAxisLabel({ name: "chr1", description: "primary assembly" }))
      .toBe("chr1 primary assembly");
    expect(sequenceAxisLabel({ name: "chr2", description: "" })).toBe("chr2");
    expect(fastaFileStem("reference.fna.bgz")).toBe("reference");
  });
});
