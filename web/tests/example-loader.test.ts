// @ts-expect-error Vitest runs this fixture loader in Node; the browser package intentionally omits Node types.
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ARABIDOPSIS_EXAMPLE_ASSETS,
  loadBundledArabidopsisAnnotation,
  loadBundledArabidopsisDetailOverviews,
  loadBundledArabidopsisExample,
  resolveExampleAssetUrl,
  type ExampleAssetFetcher,
} from "../src/example-loader";

const examplesDirectory = new URL("../public/examples/", import.meta.url);

function ownedBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(input.byteLength);
  output.set(input);
  return output;
}

async function assetBytes(fileName: string): Promise<Uint8Array<ArrayBuffer>> {
  return ownedBytes(await readFile(new URL(fileName, examplesDirectory)));
}

async function decodedOverviewBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const compressed = await assetBytes(ARABIDOPSIS_EXAMPLE_ASSETS.overview.fileName);
  const stream = new Blob([compressed.buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function fileNameFromRequest(input: RequestInfo | URL): string {
  return new URL(String(input)).pathname.split("/").at(-1)!;
}

async function checkedInAssetFetcher(
  input: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> {
  const fileName = fileNameFromRequest(input);
  if (fileName === ARABIDOPSIS_EXAMPLE_ASSETS.fasta.fileName) {
    throw new Error("The raw FASTA must not be fetched by the example loader");
  }
  const bytes = await assetBytes(fileName);
  return new Response(bytes.buffer, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

describe("bundled Arabidopsis example loader", () => {
  it("starts from only the FAI and precomputed overview, without fetching FASTA bases", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<ExampleAssetFetcher>(async (input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return checkedInAssetFetcher(input, init);
    });

    const result = await loadBundledArabidopsisExample({
      baseUrl: "https://example.test/moddotplot/",
      fetcher,
      signal: controller.signal,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "https://example.test/moddotplot/examples/Col-CEN_v1.2.fasta.fai",
      "https://example.test/moddotplot/examples/Col-CEN_v1.2.Chr1.mdp-overview-v1.gz",
    ]);
    expect(result.source).toEqual({
      url: "https://example.test/moddotplot/examples/Col-CEN_v1.2.fasta",
      fileName: "Col-CEN_v1.2.fasta",
      byteLength: 134_282_475,
    });
    expect(result.artifact.sequences).toHaveLength(7);
    expect(result.artifact.comparison).toMatchObject({ xIndex: 0, yIndex: 0, resolution: 1_000 });
    expect(result.artifact.tiles).toHaveLength(16);
  });

  it("reports monotonic aggregate byte progress through precomputed startup", async () => {
    const fetcher = vi.fn<ExampleAssetFetcher>(async (input) => {
      const bytes = await assetBytes(fileNameFromRequest(input));
      const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
      const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.enqueue(bytes.slice(0, midpoint));
          controller.enqueue(bytes.slice(midpoint));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
    });
    const progress: number[] = [];

    await loadBundledArabidopsisExample({
      fetcher,
      baseUrl: "https://example.test/",
      onProgress: (_message, value) => progress.push(value),
    });

    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.some((value) => value > 0 && value < 1)).toBe(true);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
  });

  it("accepts an overview transparently decoded by an HTTP server", async () => {
    const decoded = await decodedOverviewBytes();
    const fetcher = vi.fn<ExampleAssetFetcher>(async (input) => {
      const fileName = fileNameFromRequest(input);
      if (fileName === ARABIDOPSIS_EXAMPLE_ASSETS.overview.fileName) {
        return new Response(decoded.buffer, {
          status: 200,
          headers: {
            "content-encoding": "gzip",
            "content-length": String(ARABIDOPSIS_EXAMPLE_ASSETS.overview.byteLength),
          },
        });
      }
      return checkedInAssetFetcher(input);
    });

    const result = await loadBundledArabidopsisExample({
      baseUrl: "https://example.test/",
      fetcher,
    });

    expect(decoded.byteLength).toBe(6_003_800);
    expect(result.artifact.comparison).toMatchObject({ xIndex: 0, yIndex: 0, resolution: 1_000 });
    expect(result.artifact.tiles).toHaveLength(16);
  });

  it("rejects corrupted transparently decoded overview bytes", async () => {
    const decoded = await decodedOverviewBytes();
    decoded[decoded.byteLength - 1] = (decoded[decoded.byteLength - 1] ?? 0) ^ 1;
    const fetcher = vi.fn<ExampleAssetFetcher>(async (input) => {
      const fileName = fileNameFromRequest(input);
      if (fileName === ARABIDOPSIS_EXAMPLE_ASSETS.overview.fileName) {
        return new Response(decoded.buffer, {
          status: 200,
          headers: { "content-encoding": "gzip" },
        });
      }
      return checkedInAssetFetcher(input);
    });

    await expect(loadBundledArabidopsisExample({
      baseUrl: "https://example.test/",
      fetcher,
    }))
      .rejects.toThrow(
        'Bundled example file "Col-CEN_v1.2.Chr1.mdp-overview-v1.gz" failed its SHA-256 check.',
      );
  });

  it("downloads and verifies the annotation only when separately requested", async () => {
    const fetcher = vi.fn<ExampleAssetFetcher>(checkedInAssetFetcher);

    await loadBundledArabidopsisExample({
      baseUrl: "https://example.test/app/",
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith(".gff3"))).toBe(false);

    const progress: number[] = [];
    const annotation = await loadBundledArabidopsisAnnotation({
      baseUrl: "https://example.test/app/",
      fetcher,
      onProgress: (_message, value) => progress.push(value),
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2]![0])).toBe(
      "https://example.test/app/examples/ColCEN_CEN180.gff3",
    );
    expect(annotation).toBeInstanceOf(File);
    expect(annotation.name).toBe("ColCEN_CEN180.gff3");
    expect(annotation.size).toBe(ARABIDOPSIS_EXAMPLE_ASSETS.annotation.byteLength);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
  });

  it("loads static 2,000- and 4,000-cell Chr1 zoom levels without raw FASTA", async () => {
    const fetcher = vi.fn<ExampleAssetFetcher>(checkedInAssetFetcher);
    const artifacts = await loadBundledArabidopsisDetailOverviews({
      baseUrl: "https://example.test/app/",
      fetcher,
    });

    expect(fetcher.mock.calls.map(([input]) => fileNameFromRequest(input))).toEqual([
      "Col-CEN_v1.2.Chr1.2000.mdp-overview-v1.gz",
      "Col-CEN_v1.2.Chr1.4000.mdp-overview-v1.gz",
    ]);
    expect(artifacts.map(({ comparison }) => comparison.resolution)).toEqual([2_000, 4_000]);
    expect(artifacts.map(({ tiles }) => tiles.length)).toEqual([64, 256]);
  });

  it("declares content hashes and checked-in sizes for every provenance asset", () => {
    expect(ARABIDOPSIS_EXAMPLE_ASSETS).toMatchObject({
      fasta: { fileName: "Col-CEN_v1.2.fasta", byteLength: 134_282_475 },
      fai: { fileName: "Col-CEN_v1.2.fasta.fai", byteLength: 195 },
      overview: {
        fileName: "Col-CEN_v1.2.Chr1.mdp-overview-v1.gz",
        byteLength: 255_580,
        decodedByteLength: 6_003_800,
        decodedSha256: "0080892fff7512b1a35c205fc7ea7eab83b2ec88de3e39caedb64508ca9af4bc",
      },
      overview2000: {
        fileName: "Col-CEN_v1.2.Chr1.2000.mdp-overview-v1.gz",
        byteLength: 543_584,
        decodedByteLength: 24_009_368,
      },
      overview4000: {
        fileName: "Col-CEN_v1.2.Chr1.4000.mdp-overview-v1.gz",
        byteLength: 1_256_406,
        decodedByteLength: 96_031_736,
      },
      annotation: { fileName: "ColCEN_CEN180.gff3", byteLength: 3_647_621 },
    });
    for (const asset of Object.values(ARABIDOPSIS_EXAMPLE_ASSETS)) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("resolves both deployment subpaths and absolute application directories", () => {
    const asset = ARABIDOPSIS_EXAMPLE_ASSETS.fasta;
    expect(resolveExampleAssetUrl(asset, "/tools/moddotplot")).toBe(
      "/tools/moddotplot/examples/Col-CEN_v1.2.fasta",
    );
    expect(resolveExampleAssetUrl(asset, new URL("https://example.test/apps/mdp"))).toBe(
      "https://example.test/apps/mdp/examples/Col-CEN_v1.2.fasta",
    );
  });

  it("reports the failed startup asset and HTTP status", async () => {
    const fetcher = vi.fn<ExampleAssetFetcher>(async (input) => {
      const failed = String(input).endsWith(".fai");
      return new Response(failed ? "missing" : "ok", {
        status: failed ? 404 : 200,
        statusText: failed ? "Not Found" : "OK",
      });
    });

    await expect(loadBundledArabidopsisExample({ fetcher }))
      .rejects.toThrow(
        'Could not load bundled example file "Col-CEN_v1.2.fasta.fai" (HTTP 404 Not Found).',
      );
  });

  it("rejects a same-size FAI whose digest does not match the artifact provenance", async () => {
    const fetcher = vi.fn<ExampleAssetFetcher>(async (input) => {
      const fileName = fileNameFromRequest(input);
      const bytes = await assetBytes(fileName);
      if (fileName.endsWith(".fai")) bytes[0] = bytes[0] === 0x58 ? 0x59 : 0x58;
      return new Response(bytes.buffer, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
    });

    await expect(loadBundledArabidopsisExample({
      fetcher,
      baseUrl: "https://example.test/",
    }))
      .rejects.toThrow('Bundled example file "Col-CEN_v1.2.fasta.fai" failed its SHA-256 check.');
  });

  it("rejects annotation bytes that do not match bundled provenance", async () => {
    const bytes = await assetBytes(ARABIDOPSIS_EXAMPLE_ASSETS.annotation.fileName);
    const finalByte = bytes.byteLength - 1;
    bytes[finalByte] = (bytes[finalByte] ?? 0) ^ 1;
    const fetcher = vi.fn<ExampleAssetFetcher>(async () => new Response(bytes.buffer, {
      status: 200,
      headers: { "content-length": String(bytes.byteLength) },
    }));

    await expect(loadBundledArabidopsisAnnotation({ fetcher }))
      .rejects.toThrow('Bundled example file "ColCEN_CEN180.gff3" failed its SHA-256 check.');
  });

  it("does not start network work for an already-aborted request", async () => {
    const reason = new DOMException("The example load was cancelled.", "AbortError");
    const controller = new AbortController();
    controller.abort(reason);
    const fetcher = vi.fn<ExampleAssetFetcher>();

    await expect(loadBundledArabidopsisExample({
      fetcher,
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes cancellation through both in-flight startup fetches", async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    const fetcher = vi.fn<ExampleAssetFetcher>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const pending = loadBundledArabidopsisExample({ fetcher, signal: controller.signal, onProgress });
    const reason = new DOMException("Cancelled", "AbortError");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith("Loading precomputed Arabidopsis overview", 0);
  });
});
