/** Maximum transient sequence bytes copied into one Wasm ingestion shard. */
export const SEQUENCE_INGEST_SHARD_BYTES = 4 * 1024 * 1024;

/** Returns bounded half-open byte shards without allocating their contents. */
export function sequenceShardRanges(totalBytes: number): Array<{ start: number; end: number }> {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error("invalid sequence size");
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < totalBytes; start += SEQUENCE_INGEST_SHARD_BYTES) {
    ranges.push({ start, end: Math.min(totalBytes, start + SEQUENCE_INGEST_SHARD_BYTES) });
  }
  return ranges;
}

/** Number of matrix bins built before yielding ownership back to the worker queue. */
export function axisShardBins(resolution: number, progressive: boolean): number {
  if (!Number.isSafeInteger(resolution) || resolution <= 0) throw new Error("invalid resolution");
  return progressive ? Math.min(256, resolution) : Math.max(16, Math.min(64, Math.ceil(resolution / 16)));
}
