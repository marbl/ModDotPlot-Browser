import { describe, expect, it } from "vitest";
import {
  ReusableSequenceIngestBuffer,
  SEQUENCE_INGEST_SHARD_BYTES,
  axisShardBins,
  sequenceShardRanges,
} from "../src/sharding";

describe("bounded sequence and axis shards", () => {
  it("covers sequence bytes exactly with bounded transient shards", () => {
    const total = SEQUENCE_INGEST_SHARD_BYTES * 2 + 17;
    const ranges = sequenceShardRanges(total);
    expect(ranges).toEqual([
      { start: 0, end: SEQUENCE_INGEST_SHARD_BYTES },
      { start: SEQUENCE_INGEST_SHARD_BYTES, end: SEQUENCE_INGEST_SHARD_BYTES * 2 },
      { start: SEQUENCE_INGEST_SHARD_BYTES * 2, end: total },
    ]);
  });

  it("reuses one bounded buffer for partial ingestion shards without changing bytes", () => {
    const ingest = new ReusableSequenceIngestBuffer(8);
    const output: number[] = [];
    const partialBuffers: ArrayBufferLike[] = [];
    const consume = (shard: Uint8Array): void => {
      expect(shard.byteLength).toBeLessThanOrEqual(8);
      output.push(...shard);
      if (shard.byteLength < 8) partialBuffers.push(shard.buffer);
    };

    ingest.append(Uint8Array.of(1), consume);
    ingest.append(Uint8Array.of(2, 3), consume);
    ingest.flush(consume);
    ingest.append(Uint8Array.of(4), consume);
    ingest.append(Uint8Array.of(5, 6), consume);
    ingest.flush(consume);

    expect(output).toEqual([1, 2, 3, 4, 5, 6]);
    expect(partialBuffers).toHaveLength(2);
    expect(partialBuffers[0]).toBe(partialBuffers[1]);
  });

  it("forwards complete large shards directly and buffers only their remainder", () => {
    const ingest = new ReusableSequenceIngestBuffer(4);
    const input = Uint8Array.from({ length: 11 }, (_, index) => index + 1);
    const seen: number[][] = [];
    const buffers: ArrayBufferLike[] = [];
    const consume = (shard: Uint8Array): void => {
      seen.push([...shard]);
      buffers.push(shard.buffer);
    };

    ingest.append(input, consume);
    ingest.flush(consume);

    expect(seen).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11],
    ]);
    expect(buffers[0]).toBe(input.buffer);
    expect(buffers[1]).toBe(input.buffer);
    expect(buffers[2]).not.toBe(input.buffer);
  });

  it("preserves byte order across mixed input boundaries while bounding every shard", () => {
    const ingest = new ReusableSequenceIngestBuffer(7);
    const input = Uint8Array.from({ length: 97 }, (_, index) => index);
    const chunks: Uint8Array[] = [];
    const consume = (shard: Uint8Array): void => {
      expect(shard.byteLength).toBeLessThanOrEqual(7);
      chunks.push(Uint8Array.from(shard));
    };
    const sizes = [1, 13, 2, 7, 3, 19, 5];
    let offset = 0;
    let sizeIndex = 0;
    while (offset < input.byteLength) {
      const size = sizes[sizeIndex % sizes.length] ?? 1;
      ingest.append(input.subarray(offset, Math.min(input.byteLength, offset + size)), consume);
      offset += size;
      sizeIndex += 1;
    }
    ingest.flush(consume);

    expect(chunks.flatMap((chunk) => [...chunk])).toEqual([...input]);
  });

  it("rejects an invalid ingestion capacity", () => {
    expect(() => new ReusableSequenceIngestBuffer(0)).toThrow("invalid sequence ingestion capacity");
  });

  it("bounds progressive and background axis work between queue yields", () => {
    expect(axisShardBins(10_000, true)).toBe(256);
    expect(axisShardBins(10_000, false)).toBe(64);
    expect(axisShardBins(8, true)).toBe(8);
  });
});
