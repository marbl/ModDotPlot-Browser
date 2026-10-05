/** Maximum transient sequence bytes copied into one Wasm ingestion shard. */
export const SEQUENCE_INGEST_SHARD_BYTES = 4 * 1024 * 1024;

/**
 * Reuses one bounded staging allocation while combining small file/decompressor chunks.
 *
 * `consume` must finish reading the supplied view before returning. Full-size input
 * shards are forwarded directly; partial shards share the reusable staging buffer and
 * are overwritten by a later append or flush.
 */
export class ReusableSequenceIngestBuffer {
  readonly #capacity: number;
  #scratch: Uint8Array | null = null;
  #length = 0;

  constructor(capacity = SEQUENCE_INGEST_SHARD_BYTES) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("invalid sequence ingestion capacity");
    }
    this.#capacity = capacity;
  }

  append(chunk: Uint8Array, consume: (shard: Uint8Array) => void): void {
    if (chunk.byteLength === 0) return;

    // Preserve the existing shard boundary policy: a new input chunk that cannot fit
    // flushes the current partial shard before complete input-sized shards are sent.
    if (this.#length > 0 && this.#length + chunk.byteLength > this.#capacity) {
      this.flush(consume);
    }

    let offset = 0;
    while (chunk.byteLength - offset >= this.#capacity) {
      consume(chunk.subarray(offset, offset + this.#capacity));
      offset += this.#capacity;
    }

    if (offset < chunk.byteLength) {
      const tail = chunk.subarray(offset);
      const scratch = this.#reserve(this.#length + tail.byteLength);
      scratch.set(tail, this.#length);
      this.#length += tail.byteLength;
      if (this.#length === this.#capacity) this.flush(consume);
    }
  }

  flush(consume: (shard: Uint8Array) => void): void {
    if (this.#length === 0) return;
    const scratch = this.#scratch;
    if (!scratch) throw new Error("sequence ingestion buffer is unavailable");
    const shard = scratch.subarray(0, this.#length);
    this.#length = 0;
    consume(shard);
  }

  #reserve(required: number): Uint8Array {
    if (this.#scratch && this.#scratch.byteLength >= required) return this.#scratch;
    let capacity = this.#scratch?.byteLength ?? 1;
    while (capacity < required) capacity = Math.min(this.#capacity, capacity * 2);
    const replacement = new Uint8Array(capacity);
    if (this.#scratch && this.#length > 0) {
      replacement.set(this.#scratch.subarray(0, this.#length));
    }
    this.#scratch = replacement;
    return replacement;
  }
}

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
