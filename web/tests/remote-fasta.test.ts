import { describe, expect, it } from "vitest";
import { parseRemoteFastaUrl } from "../src/remote-fasta";

describe("remote FASTA URLs", () => {
  it("normalizes the Col-CEN gzip URL used by the landing page workflow", () => {
    expect(parseRemoteFastaUrl(
      "  https://github.com/schatzlab/Col-CEN/raw/main/v1.2/Col-CEN_v1.2.fasta.gz  ",
    )).toEqual({
      url: "https://raw.githubusercontent.com/schatzlab/Col-CEN/main/v1.2/Col-CEN_v1.2.fasta.gz",
      fileName: "Col-CEN_v1.2.fasta.gz",
    });
  });

  it.each(["assembly.fa", "assembly.fasta", "assembly.fna", "assembly.fas.gz"])(
    "accepts the supported suffix in %s",
    (fileName) => {
      expect(parseRemoteFastaUrl(`https://data.example/${fileName}`).fileName).toBe(fileName);
    },
  );

  it.each([
    ["http://data.example/assembly.fa", "HTTPS"],
    ["https://user:secret@data.example/assembly.fa", "credentials"],
    ["https://data.example/genes.gff.gz", "must end"],
    ["not a url", "complete HTTPS URL"],
  ])("rejects %s", (value, message) => {
    expect(() => parseRemoteFastaUrl(value)).toThrow(message);
  });

  it("keeps query parameters while removing fragments", () => {
    expect(parseRemoteFastaUrl("https://data.example/assembly.fa?download=1#fragment").url)
      .toBe("https://data.example/assembly.fa?download=1");
  });
});
