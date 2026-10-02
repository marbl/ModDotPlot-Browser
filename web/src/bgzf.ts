const BGZF_HEADER_PREFIX_BYTES = 12;
const BGZF_MAX_HEADER_BYTES = 512;
const BGZF_MAX_BLOCK_BYTES = 65_536;

class ByteQueue {
  readonly #chunks: Uint8Array[] = [];
  #headOffset = 0;
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.#chunks.push(chunk);
    this.#length += chunk.byteLength;
  }

  peek(count: number): Uint8Array {
    if (count > this.#length) throw new Error("BGZF byte queue underflow");
    const first = this.#chunks[0];
    if (!first) return new Uint8Array();
    const available = first.byteLength - this.#headOffset;
    if (count <= available) return first.subarray(this.#headOffset, this.#headOffset + count);

    const result = new Uint8Array(count);
    let copied = 0;
    for (let index = 0; copied < count; index += 1) {
      const chunk = this.#chunks[index];
      if (!chunk) throw new Error("BGZF byte queue underflow");
      const start = index === 0 ? this.#headOffset : 0;
      const take = Math.min(chunk.byteLength - start, count - copied);
      result.set(chunk.subarray(start, start + take), copied);
      copied += take;
    }
    return result;
  }

  read(count: number): Uint8Array {
    const result = this.peek(count);
    let remaining = count;
    while (remaining > 0) {
      const first = this.#chunks[0];
      if (!first) throw new Error("BGZF byte queue underflow");
      const available = first.byteLength - this.#headOffset;
      if (remaining < available) {
        this.#headOffset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.#chunks.shift();
        this.#headOffset = 0;
      }
    }
    this.#length -= count;
    return result;
  }
}

/** Returns true when a blob begins with a valid BGZF `BC` extra field. */
export async function isBgzfBlob(blob: Blob): Promise<boolean> {
  const prefix = new Uint8Array(
    await blob.slice(0, Math.min(blob.size, BGZF_MAX_HEADER_BYTES)).arrayBuffer(),
  );
  if (prefix.byteLength < BGZF_HEADER_PREFIX_BYTES) return false;
  const extraLength = littleEndian16(prefix, 10);
  const headerLength = BGZF_HEADER_PREFIX_BYTES + extraLength;
  if (headerLength > prefix.byteLength || headerLength > BGZF_MAX_HEADER_BYTES) return false;
  return bgzfBlockSize(prefix.subarray(0, headerLength), false) !== null;
}

/**
 * Decompresses a BGZF stream block-by-block with bounded parallelism while preserving
 * byte order. Each browser decompressor receives one complete gzip member, avoiding
 * the trailing-member rejection applied to a complete BGZF file.
 */
export function decompressBgzfStream(
  source: ReadableStream<Uint8Array>,
  concurrency = defaultConcurrency(),
): ReadableStream<Uint8Array> {
  const iterator = decompressBgzfChunks(source, concurrency);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error: unknown) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

async function* decompressBgzfChunks(
  source: ReadableStream<Uint8Array>,
  requestedConcurrency: number,
): AsyncGenerator<Uint8Array, void, void> {
  const concurrency = Math.max(1, Math.min(16, Math.floor(requestedConcurrency) || 1));
  const blocks = readBgzfBlocks(source);
  type Pending = Promise<
    { ok: true; value: Uint8Array; blockNumber: number }
    | { ok: false; error: unknown; blockNumber: number }
  >;
  const pending: Pending[] = [];
  let blockNumber = 0;

  const queueNext = async (): Promise<boolean> => {
    const next = await blocks.next();
    if (next.done) return false;
    blockNumber += 1;
    const currentBlock = blockNumber;
    pending.push(decompressBlock(next.value).then(
      (value) => ({ ok: true as const, value, blockNumber: currentBlock }),
      (error: unknown) => ({ ok: false as const, error, blockNumber: currentBlock }),
    ));
    return true;
  };

  try {
    while (pending.length < concurrency && await queueNext()) {
      // Fill the bounded decompression window.
    }
    while (pending.length > 0) {
      const result = await pending.shift();
      if (!result) break;
      if (!result.ok) {
        const reason = result.error instanceof Error ? result.error.message : String(result.error);
        throw new Error(`Could not decompress BGZF block ${result.blockNumber}: ${reason}`);
      }
      if (result.value.byteLength > 0) yield result.value;
      await queueNext();
    }
  } finally {
    await blocks.return(undefined);
  }
}

async function* readBgzfBlocks(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
  const reader = source.getReader();
  const queue = new ByteQueue();
  let sourceDone = false;

  const fill = async (minimumBytes: number): Promise<void> => {
    while (!sourceDone && queue.length < minimumBytes) {
      const result = await reader.read();
      sourceDone = result.done;
      if (result.value) queue.push(result.value);
    }
  };

  try {
    while (true) {
      await fill(BGZF_HEADER_PREFIX_BYTES);
      if (sourceDone && queue.length === 0) return;
      if (queue.length < BGZF_HEADER_PREFIX_BYTES) {
        throw new Error("Truncated BGZF header at end of file");
      }

      const prefix = queue.peek(BGZF_HEADER_PREFIX_BYTES);
      const extraLength = littleEndian16(prefix, 10);
      const headerLength = BGZF_HEADER_PREFIX_BYTES + extraLength;
      if (headerLength > BGZF_MAX_HEADER_BYTES) {
        throw new Error(`BGZF header is unexpectedly large (${headerLength} bytes)`);
      }
      await fill(headerLength);
      if (queue.length < headerLength) throw new Error("Truncated BGZF extra field");
      const blockSize = bgzfBlockSize(queue.peek(headerLength), true);
      if (blockSize === null) throw new Error("Missing BGZF BC block-size field");
      if (blockSize < headerLength + 8 || blockSize > BGZF_MAX_BLOCK_BYTES) {
        throw new Error(`Invalid BGZF block size ${blockSize}`);
      }
      await fill(blockSize);
      if (queue.length < blockSize) throw new Error("Truncated BGZF block at end of file");
      yield queue.read(blockSize);
    }
  } finally {
    if (!sourceDone) await reader.cancel();
    reader.releaseLock();
  }
}

function bgzfBlockSize(header: Uint8Array, strict: boolean): number | null {
  if (
    header[0] !== 0x1f
    || header[1] !== 0x8b
    || header[2] !== 8
    || ((header[3] ?? 0) & 0x04) === 0
  ) {
    if (strict) throw new Error("Input is not a BGZF gzip block");
    return null;
  }
  const extraLength = littleEndian16(header, 10);
  const end = BGZF_HEADER_PREFIX_BYTES + extraLength;
  let offset = BGZF_HEADER_PREFIX_BYTES;
  while (offset + 4 <= end) {
    const subfieldLength = littleEndian16(header, offset + 2);
    const dataStart = offset + 4;
    const next = dataStart + subfieldLength;
    if (next > end) {
      if (strict) throw new Error("Invalid BGZF gzip extra field");
      return null;
    }
    if (header[offset] === 0x42 && header[offset + 1] === 0x43 && subfieldLength === 2) {
      return littleEndian16(header, dataStart) + 1;
    }
    offset = next;
  }
  return null;
}

async function decompressBlock(block: Uint8Array): Promise<Uint8Array> {
  // Blob snapshots the supplied view, including its byte offset and length. Normal
  // file-stream chunks use ArrayBuffer, so this avoids another complete block copy;
  // retain a safe copy fallback for a caller backed by SharedArrayBuffer.
  const bytes: Uint8Array<ArrayBuffer> = block.buffer instanceof ArrayBuffer
    ? new Uint8Array(block.buffer, block.byteOffset, block.byteLength)
    : Uint8Array.from(block);
  const compressed = new Blob([bytes]).stream() as ReadableStream<BufferSource>;
  const reader = compressed
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const expectedBytes = littleEndian32(block, block.byteLength - 4);
  let firstChunk: Uint8Array | null = null;
  let output: Uint8Array | null = null;
  let written = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = result.value;
    if (chunk.byteLength === 0) continue;
    if (!firstChunk) {
      firstChunk = chunk;
      written = chunk.byteLength;
      continue;
    }
    if (!output) {
      output = new Uint8Array(expectedBytes);
      if (written > output.byteLength) throw new Error("BGZF output exceeds its declared size");
      output.set(firstChunk);
    }
    if (written + chunk.byteLength > output.byteLength) {
      throw new Error("BGZF output exceeds its declared size");
    }
    output.set(chunk, written);
    written += chunk.byteLength;
  }
  if (written !== expectedBytes) {
    throw new Error(`BGZF output size ${written} does not match declared size ${expectedBytes}`);
  }
  return output ?? firstChunk ?? new Uint8Array();
}

function defaultConcurrency(): number {
  const cores = typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(8, Math.ceil(cores / 2)));
}

function littleEndian16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function littleEndian32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}
