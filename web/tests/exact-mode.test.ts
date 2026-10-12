import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXACT_KMER_GEOMETRY,
  exactConfigDigest,
  exactModeBannerText,
  exactTilePublicationKey,
} from "../src/exact-mode";

describe("exact k-mer display state", () => {
  it("uses full matching footprints", () => {
    expect(DEFAULT_EXACT_KMER_GEOMETRY).toBe("footprints");
  });

  it("includes geometry in exact scientific and publication identities", () => {
    expect(exactConfigDigest(21, "footprints")).toBe("exact-k21-footprints");
    expect(exactConfigDigest(21, "anchors")).toBe("exact-k21-anchors");
    expect(exactTilePublicationKey(1_024, 256, 512, "footprints"))
      .not.toBe(exactTilePublicationKey(1_024, 256, 512, "anchors"));
  });

  it("describes one-base exact rendering without hiding its semantics", () => {
    expect(exactModeBannerText(21, "footprints", "similarity"))
      .toBe("Exact · 1 bp/cell · canonical 21-mers · full footprints · color = Base");
    expect(exactModeBannerText(17, "anchors", "similarity"))
      .toBe("Exact · 1 bp/cell · canonical 17-mers · k-mer anchors · color = Base");
    expect(exactModeBannerText(17, "anchors", "direction"))
      .toContain("color = direction");
  });
});
