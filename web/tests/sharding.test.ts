import { describe, expect, it } from "vitest";
import {
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

  it("bounds progressive and background axis work between queue yields", () => {
    expect(axisShardBins(10_000, true)).toBe(256);
    expect(axisShardBins(10_000, false)).toBe(64);
    expect(axisShardBins(8, true)).toBe(8);
  });
});
