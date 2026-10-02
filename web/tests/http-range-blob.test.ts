import { describe, expect, it } from "vitest";
import {
  createHttpRangeBlob,
  type HttpRangeFetcher,
} from "../src/http-range-blob";
import { createIndexedFastaSource } from "../src/indexed-fasta";

describe("same-origin HTTP range Blob", () => {
  it("interoperates with indexed FASTA using one streamed request for a large record", async () => {
    const bases = "ACGT".repeat(40_000);
    const fasta = new TextEncoder().encode(`>chr1\n${bases}\n`);
    const server = rangeServer(fasta, 11_003);
    const remote = await createHttpRangeBlob("examples/genome.fa", {
      baseUrl: "https://example.test/app/",
      fetcher: server.fetcher,
    });
    const source = await createIndexedFastaSource(
      remote,
      `chr1\t${bases.length}\t6\t${bases.length}\t${bases.length + 1}\n`,
    );

    const chunks = await collectChunks(source.streamRecord("chr1"));
    expect(new TextDecoder().decode(concatenate(chunks))).toBe(bases);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(64 * 1024);
    expect(server.requests.map((request) => request.range)).toEqual([
      "bytes=0-1",
      `bytes=6-${6 + bases.length}`,
    ]);
    expect(server.requests[1]?.ifRange).toBe('"fixture-v1"');
    expect(remote.size).toBe(fasta.byteLength);
    expect(remote.url).toBe("https://example.test/app/examples/genome.fa");
  });

  it("supports lazy slices without fetching bytes until they are read", async () => {
    const bytes = new TextEncoder().encode(">r\nACGTACGT\n");
    const server = rangeServer(bytes);
    const remote = await createHttpRangeBlob("/genome.fa", {
      baseUrl: "https://example.test/app/",
      fetcher: server.fetcher,
    });
    const slice = remote.slice(3, 7);
    expect(server.requests).toHaveLength(1);
    expect(await slice.text()).toBe("ACGT");
    expect(server.requests.map((request) => request.range)).toEqual([
      "bytes=0-1",
      "bytes=3-6",
    ]);
  });

  it("binds brand-checked fetch implementations to the active global scope", async () => {
    const bytes = new TextEncoder().encode(">r\nACGTACGT\n");
    const server = rangeServer(bytes);
    const brandCheckedFetcher: HttpRangeFetcher = function (this: unknown, input, init) {
      if (this !== globalThis) {
        throw new TypeError(
          "Can only call WorkerGlobalScope.fetch on instances of WorkerGlobalScope",
        );
      }
      return server.fetcher(input, init);
    };
    const remote = await createHttpRangeBlob("/genome.fa", {
      baseUrl: "https://example.test/app/",
      fetcher: brandCheckedFetcher,
    });

    expect(await remote.slice(3, 7).text()).toBe("ACGT");
    expect(server.requests.map((request) => request.range)).toEqual([
      "bytes=0-1",
      "bytes=3-6",
    ]);
  });

  it("rejects a server that ignores Range before consuming its full response", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher: HttpRangeFetcher = async () => new Response(body, { status: 200 });
    await expect(createHttpRangeBlob("/genome.fa", {
      baseUrl: "https://example.test/app/",
      fetcher,
    })).rejects.toThrow(/ignored the HTTP Range request.*refusing/u);
    expect(cancelled).toBe(true);
  });

  it("rejects malformed, shifted, and changing Content-Range metadata", async () => {
    const body = new Uint8Array([62, 114, 10, 65, 10]);
    const invalidHeader: HttpRangeFetcher = async () => partialResponse(
      body.subarray(0, 2),
      "octets 0-1/5",
    );
    await expect(createHttpRangeBlob("/genome.fa", {
      baseUrl: "https://example.test/",
      fetcher: invalidHeader,
    })).rejects.toThrow(/invalid Content-Range/u);

    const shifted: HttpRangeFetcher = async () => partialResponse(
      body.subarray(0, 2),
      "bytes 1-2/5",
    );
    await expect(createHttpRangeBlob("/genome.fa", {
      baseUrl: "https://example.test/",
      fetcher: shifted,
    })).rejects.toThrow(/expected bytes 0-1/u);

    const server = rangeServer(body);
    const remote = await createHttpRangeBlob("/genome.fa", {
      baseUrl: "https://example.test/",
      fetcher: async (input, init) => {
        const response = await server.fetcher(input, init);
        if (new Headers(init?.headers).get("Range") === "bytes=2-3") {
          return partialResponse(body.subarray(2, 4), "bytes 2-3/6");
        }
        return response;
      },
    });
    await expect(remote.slice(2, 4).arrayBuffer()).rejects.toThrow(/size changed from 5 to 6/u);
  });

  it("rejects encoded ranges and cross-origin URLs", async () => {
    const encoded: HttpRangeFetcher = async () => partialResponse(
      new Uint8Array([62, 114]),
      "bytes 0-1/4",
      { "Content-Encoding": "gzip" },
    );
    await expect(createHttpRangeBlob("/genome.fa", {
      baseUrl: "https://example.test/app/",
      fetcher: encoded,
    })).rejects.toThrow(/identity Content-Encoding/u);

    let fetched = false;
    await expect(createHttpRangeBlob("https://other.test/genome.fa", {
      baseUrl: "https://example.test/app/",
      fetcher: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
    })).rejects.toThrow(/must be same-origin/u);
    expect(fetched).toBe(false);
  });

  it("cancels an in-flight range body without leaking a rejected cancellation", async () => {
    const probe = new Uint8Array([62, 114]);
    let cancelled = false;
    let requests = 0;
    const fetcher: HttpRangeFetcher = async (_input, _init) => {
      requests += 1;
      if (requests === 1) return partialResponse(probe, "bytes 0-1/10");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([10, 65]));
        },
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          cancelled = true;
          return Promise.reject(new Error("simulated transport cancellation failure"));
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          "Content-Range": "bytes 2-9/10",
          "Content-Length": "8",
        },
      });
    };
    const remote = await createHttpRangeBlob("/genome.fa", {
      baseUrl: "https://example.test/app/",
      fetcher,
    });
    const controller = new AbortController();
    const reader = remote.streamRange(2, 10, { signal: controller.signal }).getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

interface RecordedRequest {
  readonly range: string | null;
  readonly ifRange: string | null;
}

function rangeServer(bytes: Uint8Array, chunkBytes = bytes.byteLength): {
  readonly requests: RecordedRequest[];
  readonly fetcher: HttpRangeFetcher;
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetcher: async (_input, init) => {
      const headers = new Headers(init?.headers);
      const range = headers.get("Range");
      requests.push({ range, ifRange: headers.get("If-Range") });
      const match = /^bytes=([0-9]+)-([0-9]+)$/u.exec(range ?? "");
      if (!match) return new Response("Range required", { status: 400 });
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start > end || end >= bytes.byteLength) {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${bytes.byteLength}` },
        });
      }
      const selected = bytes.slice(start, end + 1);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= selected.byteLength) {
            controller.close();
            return;
          }
          const next = Math.min(selected.byteLength, offset + Math.max(1, chunkBytes));
          controller.enqueue(selected.subarray(offset, next));
          offset = next;
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
          "Content-Length": String(selected.byteLength),
          ETag: '"fixture-v1"',
        },
      });
    },
  };
}

function partialResponse(
  bytes: Uint8Array,
  contentRange: string,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(copyArrayBuffer(bytes), {
    status: 206,
    headers: {
      "Content-Range": contentRange,
      "Content-Length": String(bytes.byteLength),
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

async function collectChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(result.value);
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
