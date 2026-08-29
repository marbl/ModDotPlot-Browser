import { describe, expect, it } from "vitest";
import { parseFeatureTrack } from "../src/features";

describe("feature tracks", () => {
  it("parses BED12 blocks and validates the sequence name", () => {
    const track = parseFeatureTrack(
      "chr1\t10\t100\tgeneA\t0\t+\t20\t80\t0\t2\t20,30,\t0,60,\n",
      "genes.bed",
      "chr1 description",
      1_000,
    );
    expect(track.format).toBe("BED");
    expect(track.features[0]?.blocks).toHaveLength(3);
  });

  it("parses one-based inclusive GFF coordinates", () => {
    const track = parseFeatureTrack(
      "chr1\tsource\texon\t11\t20\t.\t-\t.\tID=e1;Parent=t1\n",
      "genes.gff3",
      "chr1",
      100,
    );
    expect(track.features[0]).toMatchObject({ start: 10, end: 20, strand: "-", group: "t1" });
  });

  it("rejects a track with no selected sequence name", () => {
    expect(() => parseFeatureTrack("chr2\t0\t10\n", "wrong.bed", "chr1", 100)).toThrow(
      /does not contain features named for chr1/,
    );
  });

  it("rejects coordinates beyond the selected sequence", () => {
    expect(() => parseFeatureTrack("chr1\t0\t101\n", "wrong.bed", "chr1", 100)).toThrow(
      /beyond chr1/,
    );
  });
});
