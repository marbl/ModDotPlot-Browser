import { describe, expect, it } from "vitest";
import { decompressBgzfStream, isBgzfBlob } from "../src/bgzf";

describe("BGZF streaming", () => {
  it("detects and decompresses fragmented members in order", async () => {
    const expected = ">chr1\nACGTACGTACGT\n>chr2\nTTTTCCCC\n";
    const compressed = concatenate(await Promise.all([
      bgzfBlock(">chr1\nACGT"),
      bgzfBlock("ACGTACGT\n>chr2\n"),
      bgzfBlock("TTTTCCCC\n"),
    ]));
    expect(await isBgzfBlob(new Blob([arrayBuffer(compressed)]))).toBe(true);

    const fragments = fragment(compressed, [3, 11, 7, 31, 2, 53]);
    const decoded = await collect(decompressBgzfStream(streamOf(fragments), 3));
    expect(new TextDecoder().decode(decoded)).toBe(expected);
  });

  it("does not misclassify an ordinary gzip member", async () => {
    const gzip = await gzipBytes(">ordinary\nACGT\n");
    expect(await isBgzfBlob(new Blob([arrayBuffer(gzip)]))).toBe(false);
  });

  it("decompresses a block supplied as an offset view without surrounding bytes", async () => {
    const expected = `>offset\n${"ACGT".repeat(4_000)}\n`;
    const block = await bgzfBlock(expected);
    const padded = new Uint8Array(block.byteLength + 19);
    padded.fill(0xa5);
    padded.set(block, 7);
    const view = padded.subarray(7, 7 + block.byteLength);

    const decoded = await collect(decompressBgzfStream(streamOf([view]), 1));
    expect(new TextDecoder().decode(decoded)).toBe(expected);
  });

  it("preserves a near-maximum decompressed BGZF payload", async () => {
    const expected = "A".repeat(65_000);
    const block = await bgzfBlock(expected);
    const decoded = await collect(decompressBgzfStream(streamOf(fragment(block, [13, 29, 5])), 2));
    expect(decoded.byteLength).toBe(expected.length);
    expect(new TextDecoder().decode(decoded)).toBe(expected);
  });
});

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
  const stream = input.pipeThrough(new CompressionStream("gzip")) as ReadableStream<Uint8Array>;
  return collect(stream);
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function fragment(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const size = sizes[index % sizes.length] ?? 1;
    chunks.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + size)));
    offset += size;
    index += 1;
  }
  return chunks;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
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
  return concatenate(chunks.length > 0 ? chunks : [new Uint8Array(total)]);
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
