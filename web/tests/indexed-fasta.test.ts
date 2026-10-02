import { describe, expect, it } from "vitest";
import {
  associateFastaIndexFiles,
  canUseIndexedFastaInput,
  createIndexedFastaSource,
  indexedRecordRange,
  parseFai,
  parseGzi,
  planBgzfRange,
  type GziCheckpoint,
} from "../src/indexed-fasta";

describe("indexed FASTA browser companions", () => {
  it("associates exact FAI and GZI companions while preserving FASTA order", () => {
    const first = new File([">one\nACGT\n"], "first.fa");
    const second = new File([">two\nTGCA\n"], "second.fa.bgz");
    const inputs = associateFastaIndexFiles([
      new File([""], "second.fa.bgz.gzi"),
      first,
      new File(["one\t4\t5\t4\t5\n"], "first.fa.fai"),
      second,
      new File(["two\t4\t5\t4\t5\n"], "second.fa.bgz.fai"),
    ]);

    expect(inputs.map((input) => ({
      fasta: input.fasta.name,
      fai: input.fai?.name,
      gzi: input.gzi?.name,
    }))).toEqual([
      { fasta: "first.fa", fai: "first.fa.fai", gzi: undefined },
      { fasta: "second.fa.bgz", fai: "second.fa.bgz.fai", gzi: "second.fa.bgz.gzi" },
    ]);
  });

  it("normalizes companion suffix case and detects mixed-case duplicates", () => {
    const fasta = new File([">one\nACGT\n"], "input.fa");
    const [input] = associateFastaIndexFiles([
      fasta,
      new File(["one\t4\t5\t4\t5\n"], "input.fa.FAI"),
    ]);
    expect(input?.fai?.name).toBe("input.fa.FAI");
    expect(() => associateFastaIndexFiles([
      fasta,
      new File([""], "input.fa.fai"),
      new File([""], "input.fa.FAI"),
    ])).toThrow(/More than one index file/);
  });

  it("keeps case-distinct FASTA basenames and companions separate", () => {
    const lower = new File([">lower\nACGT\n"], "sample.fa");
    const upper = new File([">upper\nTGCA\n"], "SAMPLE.FA");
    const inputs = associateFastaIndexFiles([
      lower,
      upper,
      new File(["lower\t4\t7\t4\t5\n"], "sample.fa.FAI"),
      new File(["upper\t4\t7\t4\t5\n"], "SAMPLE.FA.fai"),
    ]);
    expect(inputs.map((input) => [input.fasta.name, input.fai?.name])).toEqual([
      ["sample.fa", "sample.fa.FAI"],
      ["SAMPLE.FA", "SAMPLE.FA.fai"],
    ]);
  });

  it("keeps incomplete matched companions available for eager fallback", () => {
    const fasta = new File([">one\nACGT\n"], "input.fa.bgz");
    const [input] = associateFastaIndexFiles([
      fasta,
      new File(["one\t4\t5\t4\t5\n"], "input.fa.bgz.fai"),
    ]);
    expect(input).toMatchObject({ fasta, gzi: null });
    expect(input?.fai?.name).toBe("input.fa.bgz.fai");
  });

  it("rejects orphan, duplicate, and ambiguous index selections", () => {
    expect(() => associateFastaIndexFiles([
      new File([""], "missing.fa.fai"),
    ])).toThrow(/no matching FASTA file named 'missing\.fa'/);
    expect(() => associateFastaIndexFiles([
      new File([">one\nACGT\n"], "input.fa"),
      new File([""], "input.fa.fai"),
      new File([""], "input.fa.fai"),
    ])).toThrow(/More than one index file/);
    expect(() => associateFastaIndexFiles([
      new File([">one\nACGT\n"], "input.fa"),
      new File([">two\nTGCA\n"], "input.fa"),
      new File([""], "input.fa.fai"),
    ])).toThrow(/more than one selected FASTA/);
  });

  it("indexes only plain FAI or complete BGZF FAI/GZI inputs", async () => {
    const fai = new File(["one\t4\t5\t4\t5\n"], "input.fa.fai");
    const plain = new File([">one\nACGT\n"], "input.fa");
    await expect(canUseIndexedFastaInput({ fasta: plain, fai, gzi: null })).resolves.toBe(true);

    const ordinaryGzip = new File(
      [arrayBuffer(await gzipBytes(">one\nACGT\n"))],
      "input.fa.gz",
    );
    const ordinaryFai = new File(["one\t4\t5\t4\t5\n"], "input.fa.gz.fai");
    const ordinaryGzi = new File([arrayBuffer(gziBytes([]))], "input.fa.gz.gzi");
    await expect(canUseIndexedFastaInput({
      fasta: ordinaryGzip,
      fai: ordinaryFai,
      gzi: ordinaryGzi,
    })).resolves.toBe(false);

    const block = await bgzfBlock(">one\nACGT\n");
    const bgzf = new File([arrayBuffer(block)], "input.fa.bgz");
    const bgzfFai = new File(["one\t4\t5\t4\t5\n"], "input.fa.bgz.fai");
    const bgzfGzi = new File([arrayBuffer(gziBytes([]))], "input.fa.bgz.gzi");
    await expect(canUseIndexedFastaInput({ fasta: bgzf, fai: bgzfFai, gzi: null }))
      .resolves.toBe(false);
    await expect(canUseIndexedFastaInput({ fasta: bgzf, fai: bgzfFai, gzi: bgzfGzi }))
      .resolves.toBe(true);
  });
});

describe("indexed FASTA indexes", () => {
  it("parses strict FAI text with LF and CRLF index lines", () => {
    const records = parseFai("chr1\t10\t7\t4\t6\r\nchr2\t4\t30\t4\t5\r\n");
    expect(records).toEqual([
      { name: "chr1", length: 10, offset: 7, lineBases: 4, lineWidth: 6 },
      { name: "chr2", length: 4, offset: 30, lineBases: 4, lineWidth: 5 },
    ]);
    expect(indexedRecordRange(records[0]!, 3, 9)).toMatchObject({
      start: 3,
      end: 9,
      uncompressedStart: 10,
      uncompressedEnd: 20,
    });
  });

  it("rejects malformed, unsafe, duplicate, and overlapping FAI records", () => {
    expect(() => parseFai("chr1\t10\t6\t4\n")).toThrow(/exactly five/);
    expect(() => parseFai("chr1\t01\t6\t4\t5\n")).toThrow(/unsigned decimal/);
    expect(() => parseFai("chr1\t9007199254740992\t6\t4\t5\n")).toThrow(/safe integer/);
    expect(() => parseFai("chr1\t4\t6\t4\t5\nchr1\t4\t20\t4\t5\n")).toThrow(/duplicate/);
    expect(() => parseFai("chr1\t20\t6\t4\t5\nchr2\t4\t20\t4\t5\n")).toThrow(/overlaps/);
    expect(() => parseFai("chr1\t4\t6\t4\t7\n")).toThrow(/line width/);
  });

  it("parses little-endian GZI checkpoints and rejects malformed layouts", () => {
    const bytes = gziBytes([
      { compressedOffset: 100, uncompressedOffset: 64 },
      { compressedOffset: 220, uncompressedOffset: 128 },
    ]);
    expect(parseGzi(bytes)).toEqual([
      { compressedOffset: 0, uncompressedOffset: 0 },
      { compressedOffset: 100, uncompressedOffset: 64 },
      { compressedOffset: 220, uncompressedOffset: 128 },
    ]);
    expect(() => parseGzi(bytes.subarray(0, bytes.byteLength - 1))).toThrow(/byte length/);
    expect(() => parseGzi(gziBytes([
      { compressedOffset: 100, uncompressedOffset: 64 },
      { compressedOffset: 99, uncompressedOffset: 128 },
    ]))).toThrow(/increase strictly/);

    const unsafe = new Uint8Array(24);
    const view = new DataView(unsafe.buffer);
    view.setBigUint64(0, 1n, true);
    view.setBigUint64(8, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    view.setBigUint64(16, 1n, true);
    expect(() => parseGzi(unsafe)).toThrow(/safe integer/);
  });
});

describe("indexed FASTA random access", () => {
  it("extracts bounded plain-FASTA ranges across wrapped CRLF lines", async () => {
    const fasta = new Blob([">chr1\r\nACGT\r\nTGCA\r\nAC\r\n>chr2\r\nGGGG\r\n"]);
    const source = await createIndexedFastaSource(
      fasta,
      "chr1\t10\t7\t4\t6\nchr2\t4\t30\t4\t6\n",
    );
    expect(source.compression).toBe("plain");
    expect(source.getRecord("chr2")?.length).toBe(4);
    expect(await decode(source.streamRecord("chr1"))).toBe("ACGTTGCAAC");
    expect(await decode(source.streamRecord("chr1", { start: 3, end: 9 }))).toBe("TTGCAA");
    expect(await decode(source.streamRecord("chr2"))).toBe("GGGG");
    expect(await decode(await source.streamFastaRecord("chr1"))).toBe(
      ">chr1\r\nACGT\r\nTGCA\r\nAC",
    );
  });

  it("handles exact line boundaries and a missing final newline", async () => {
    const source = await createIndexedFastaSource(
      new Blob([">r\nACGT\nTGCA"]),
      "r\t8\t3\t4\t5\n",
    );
    expect(await decode(source.streamRecord("r"))).toBe("ACGTTGCA");
    expect(await decode(source.streamRecord("r", { start: 4, end: 8 }))).toBe("TGCA");
    expect(await decode(await source.streamFastaRecord("r"))).toBe(">r\nACGT\nTGCA");
  });

  it("rejects a truncated partial final line instead of silently shortening a record", async () => {
    await expect(createIndexedFastaSource(
      new Blob([">r\nACGT\nTGC"]),
      "r\t8\t3\t4\t5\n",
    )).rejects.toThrow(/extends beyond/);
  });

  it("rejects a BGZF range that ends before the FAI-declared record", async () => {
    const block = await bgzfBlock(">r\nACGT\n");
    const source = await createIndexedFastaSource(
      new Blob([arrayBuffer(block)]),
      "r\t8\t3\t4\t5\n",
      { gzi: gziBytes([]) },
    );
    await expect(decode(await source.streamFastaRecord("r")))
      .rejects.toThrow(/ended .* before the indexed range/);
  });

  it("rejects a stale FAI record name bound to another valid header", async () => {
    const source = await createIndexedFastaSource(
      new Blob([">actualA\nAAAA\n>actualB\nCCCC\n"]),
      "claimedA\t4\t23\t4\t5\n",
    );
    await expect(source.streamFastaRecord("claimedA"))
      .rejects.toThrow(/points to FASTA header 'actualB'/);
  });

  it("uses GZI checkpoints to extract a BGZF record range without decoding its prefix", async () => {
    const texts = [">chr1\nAC", "GT\nTGCA\n", "AC\n"];
    const blocks = await Promise.all(texts.map(bgzfBlock));
    const compressedOffsets = [0, blocks[0]!.byteLength, blocks[0]!.byteLength + blocks[1]!.byteLength];
    const uncompressedOffsets = [0, texts[0]!.length, texts[0]!.length + texts[1]!.length];
    const gzi = gziBytes([
      { compressedOffset: compressedOffsets[1]!, uncompressedOffset: uncompressedOffsets[1]! },
      { compressedOffset: compressedOffsets[2]!, uncompressedOffset: uncompressedOffsets[2]! },
    ]);
    const fasta = new Blob([arrayBuffer(concatenate(blocks))]);
    const source = await createIndexedFastaSource(fasta, "chr1\t10\t6\t4\t5\n", { gzi });
    expect(source.compression).toBe("bgzf");
    expect(await decode(source.streamRecord("chr1", { start: 2, end: 9 }))).toBe("GTTGCAA");

    const range = indexedRecordRange(source.getRecord("chr1")!, 4, 8);
    const plan = planBgzfRange(source.checkpoints!, range.uncompressedStart, range.uncompressedEnd, fasta.size);
    expect(plan).toEqual({
      compressedStart: compressedOffsets[1],
      compressedEnd: compressedOffsets[2],
      checkpointUncompressedOffset: uncompressedOffsets[1],
      skipBytes: 3,
      takeBytes: 5,
    });
    expect(await decode(source.streamRecord("chr1", { start: 4, end: 8 }))).toBe("TGCA");
    expect(await decode(await source.streamFastaRecord("chr1"))).toBe(">chr1\nACGT\nTGCA\nAC");
  });

  it("rejects mismatched compression, invalid bounds, and caller-limit overflow", async () => {
    const plain = new Blob([">r\nACGT\n"]);
    const fai = "r\t4\t3\t4\t5\n";
    const source = await createIndexedFastaSource(plain, fai);
    expect(() => source.streamRecord("missing")).toThrow(/does not contain/);
    expect(() => source.streamRecord("r", { start: -1 })).toThrow(/nonnegative/);
    expect(() => source.streamRecord("r", { start: 3, end: 2 })).toThrow(/exceeds its end/);
    expect(() => source.streamRecord("r", { end: 5 })).toThrow(/exceeds record/);
    expect(() => source.streamRecord("r", { maxBases: 3 })).toThrow(/caller limit/);

    const gzip = await gzipBytes(">r\nACGT\n");
    await expect(createIndexedFastaSource(new Blob([arrayBuffer(gzip)]), fai))
      .rejects.toThrow(/requires BGZF input and a matching GZI/);
    await expect(createIndexedFastaSource(plain, fai, { gzi: gziBytes([]) }))
      .rejects.toThrow(/requires a BGZF/);
  });

  it("honors cancellation without leaking a rejected source cancellation", async () => {
    const bases = "ACGT".repeat(300_000);
    const bytes = new TextEncoder().encode(`>large\n${bases}`);
    let cancellationCount = 0;
    const fasta = Object.assign(new Blob([bytes]), {
      streamRange(start: number, end: number): ReadableStream<Uint8Array> {
        let position = start;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (position > start) return new Promise<void>(() => undefined);
            const next = Math.min(end, position + 64 * 1024);
            controller.enqueue(bytes.slice(position, next));
            position = next;
          },
          cancel() {
            cancellationCount += 1;
            return Promise.reject(new Error("simulated source cancellation failure"));
          },
        });
      },
    });
    const source = await createIndexedFastaSource(
      fasta,
      `large\t${bases.length}\t7\t${bases.length}\t${bases.length}\n`,
    );

    const preflight = new AbortController();
    preflight.abort();
    await expect(collect(source.streamRecord("large", { signal: preflight.signal })))
      .rejects.toMatchObject({ name: "AbortError" });

    const active = new AbortController();
    const reader = source.streamRecord("large", { signal: active.signal }).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    active.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancellationCount).toBe(2);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it("aborts BGZF header validation before returning a raw record stream", async () => {
    const block = await bgzfBlock(">chr1\nACGT\n");
    const source = await createIndexedFastaSource(
      new Blob([arrayBuffer(block)]),
      "chr1\t4\t6\t4\t5\n",
      { gzi: gziBytes([]) },
    );
    const controller = new AbortController();
    controller.abort();
    await expect(source.streamFastaRecord("chr1", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});

function gziBytes(checkpoints: readonly GziCheckpoint[]): Uint8Array {
  const bytes = new Uint8Array(8 + checkpoints.length * 16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(checkpoints.length), true);
  checkpoints.forEach((checkpoint, index) => {
    view.setBigUint64(8 + index * 16, BigInt(checkpoint.compressedOffset), true);
    view.setBigUint64(16 + index * 16, BigInt(checkpoint.uncompressedOffset), true);
  });
  return bytes;
}

async function bgzfBlock(text: string): Promise<Uint8Array> {
  const gzip = await gzipBytes(text);
  const block = new Uint8Array(gzip.byteLength + 8);
  block.set(gzip.subarray(0, 10));
  block[3] = 0x04;
  setLittleEndian16(block, 10, 6);
  block[12] = 0x42;
  block[13] = 0x43;
  setLittleEndian16(block, 14, 2);
  setLittleEndian16(block, 16, block.byteLength - 1);
  block.set(gzip.subarray(10), 18);
  return block;
}

async function gzipBytes(text: string): Promise<Uint8Array> {
  const input = new Blob([text]).stream() as ReadableStream<BufferSource>;
  return collect(input.pipeThrough(new CompressionStream("gzip")) as ReadableStream<Uint8Array>);
}

async function decode(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await collect(stream));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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

function setLittleEndian16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
