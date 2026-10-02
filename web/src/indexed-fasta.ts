import { decompressBgzfStream, isBgzfBlob } from "./bgzf";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const GZI_HEADER_BYTES = 8;
const GZI_ENTRY_BYTES = 16;
const INDEXED_STREAM_CHUNK_BYTES = 64 * 1024;
const MAX_BGZF_UNCOMPRESSED_BLOCK_BYTES = 64 * 1024;
const MAX_FASTA_HEADER_LOOKBACK_BYTES = 256 * 1024;

/** One strict five-column FASTA index (`.fai`) record. */
export interface FaiRecord {
  readonly name: string;
  readonly length: number;
  /** Uncompressed byte offset of the record's first base. */
  readonly offset: number;
  readonly lineBases: number;
  /** Bytes per complete sequence line, including its line ending. */
  readonly lineWidth: number;
}

/** One BGZF seek point. Offsets address compressed and uncompressed byte streams. */
export interface GziCheckpoint {
  readonly compressedOffset: number;
  readonly uncompressedOffset: number;
}

/** A validated base interval and its enclosing uncompressed FASTA byte interval. */
export interface IndexedRecordRange {
  readonly record: FaiRecord;
  readonly start: number;
  readonly end: number;
  readonly uncompressedStart: number;
  readonly uncompressedEnd: number;
}

/** The compressed window needed to decode one uncompressed byte interval. */
export interface BgzfRangePlan {
  readonly compressedStart: number;
  readonly compressedEnd: number;
  readonly checkpointUncompressedOffset: number;
  readonly skipBytes: number;
  readonly takeBytes: number;
}

export interface IndexedRecordStreamOptions {
  /** Zero-based base offset within the indexed record. Defaults to zero. */
  readonly start?: number;
  /** Exclusive base offset within the indexed record. Defaults to record length. */
  readonly end?: number;
  /** Optional caller limit for one requested base interval. */
  readonly maxBases?: number;
  readonly signal?: AbortSignal;
}

/** A Blob that can stream an exact byte interval without materializing its contents. */
export interface RangeReadableBlob extends Blob {
  streamRange(
    start: number,
    end: number,
    options?: Pick<IndexedRecordStreamOptions, "signal">,
  ): ReadableStream<Uint8Array>;
}

/** Narrows a Blob to an implementation with bounded, source-native range streaming. */
export function isRangeReadableBlob(file: Blob): file is RangeReadableBlob {
  return typeof (file as Partial<RangeReadableBlob>).streamRange === "function";
}

export interface IndexedFastaSource {
  readonly file: Blob;
  readonly compression: "plain" | "bgzf";
  readonly records: readonly FaiRecord[];
  readonly checkpoints: readonly GziCheckpoint[] | null;
  getRecord(name: string): FaiRecord | undefined;
  /** Streams one real FASTA header and its raw wrapped sequence bytes. */
  streamFastaRecord(name: string, options?: Pick<IndexedRecordStreamOptions, "signal">): Promise<ReadableStream<Uint8Array>>;
  streamRecord(name: string, options?: IndexedRecordStreamOptions): ReadableStream<Uint8Array>;
}

export interface IndexedFastaSourceOptions {
  /** The matching binary `.gzi` index. Its presence selects BGZF random access. */
  readonly gzi?: ArrayBuffer | Uint8Array;
}

/** One selected FASTA and any exact-name browser companions supplied beside it. */
export interface FastaInputFiles {
  readonly fasta: File;
  readonly fai: File | null;
  readonly gzi: File | null;
}

/**
 * Associates browser-selected indexes using the standard `<fasta>.fai` and
 * `<fasta>.gzi` names. Indexes without a matching FASTA are rejected before any
 * sequence session is mutated; incomplete, but otherwise matched, companion sets
 * are returned so callers can deliberately fall back to sequential ingestion.
 */
export function associateFastaIndexFiles(files: readonly File[]): readonly FastaInputFiles[] {
  const fastaFiles = files.filter((file) => !/\.(?:fai|gzi)$/i.test(file.name));
  const indexes = files.filter((file) => /\.(?:fai|gzi)$/i.test(file.name));
  const indexesByName = new Map<string, File>();

  for (const index of indexes) {
    const normalizedIndexName = indexAssociationKey(index.name);
    if (indexesByName.has(normalizedIndexName)) {
      throw new Error(`More than one index file is named '${index.name}'.`);
    }
    indexesByName.set(normalizedIndexName, index);
    const fastaName = index.name.replace(/\.(?:fai|gzi)$/i, "");
    const matches = fastaFiles.filter((file) => file.name === fastaName);
    if (matches.length === 0) {
      throw new Error(`Index file '${index.name}' has no matching FASTA file named '${fastaName}'.`);
    }
    if (matches.length > 1) {
      throw new Error(`Index file '${index.name}' matches more than one selected FASTA named '${fastaName}'.`);
    }
  }

  return Object.freeze(fastaFiles.map((fasta) => Object.freeze({
    fasta,
    fai: indexesByName.get(`${fasta.name}.fai`) ?? null,
    gzi: indexesByName.get(`${fasta.name}.gzi`) ?? null,
  })));
}

function indexAssociationKey(name: string): string {
  const match = /^(.*)\.(fai|gzi)$/i.exec(name);
  if (!match?.[1] || !match[2]) throw new Error(`Unsupported FASTA index filename '${name}'.`);
  return `${match[1]}.${match[2].toLocaleLowerCase("en-US")}`;
}

/** Selects only index combinations that support bounded random access. */
export async function canUseIndexedFastaInput(input: FastaInputFiles): Promise<boolean> {
  if (!input.fai) return false;
  const gzip = await hasGzipMagic(input.fasta);
  if (!gzip) return input.gzi === null;
  if (!input.gzi) return false;
  return isBgzfBlob(input.fasta);
}

/** Parses strict FASTA `.fai` text and rejects ambiguous or overlapping layouts. */
export function parseFai(text: string): readonly FaiRecord[] {
  if (text.length === 0) throw new Error("FAI index is empty");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error("FAI index is empty");

  const names = new Set<string>();
  const records: FaiRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index] ?? "";
    const line = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
    const lineNumber = index + 1;
    if (line.length === 0) throw new Error(`FAI line ${lineNumber} is empty`);
    const fields = line.split("\t");
    if (fields.length !== 5) {
      throw new Error(`FAI line ${lineNumber} must contain exactly five tab-separated fields`);
    }
    const name = fields[0] ?? "";
    if (name.length === 0 || /\s/u.test(name)) {
      throw new Error(`FAI line ${lineNumber} has an invalid sequence name`);
    }
    if (names.has(name)) throw new Error(`FAI contains duplicate sequence name '${name}'`);

    const length = decimalInteger(fields[1] ?? "", `FAI line ${lineNumber} length`);
    const offset = decimalInteger(fields[2] ?? "", `FAI line ${lineNumber} offset`);
    const lineBases = decimalInteger(fields[3] ?? "", `FAI line ${lineNumber} line bases`);
    const lineWidth = decimalInteger(fields[4] ?? "", `FAI line ${lineNumber} line width`);
    if (length === 0) throw new Error(`FAI line ${lineNumber} describes an empty record`);
    if (offset === 0) throw new Error(`FAI line ${lineNumber} base offset must follow a FASTA header`);
    if (lineBases === 0 || lineBases > length) {
      throw new Error(`FAI line ${lineNumber} has invalid bases-per-line`);
    }
    const lineEndingBytes = lineWidth - lineBases;
    if (lineEndingBytes < 0 || lineEndingBytes > 2) {
      throw new Error(`FAI line ${lineNumber} line width must encode LF, CRLF, or no final line ending`);
    }

    const record = Object.freeze({ name, length, offset, lineBases, lineWidth });
    const previous = records.at(-1);
    if (previous) {
      if (offset <= previous.offset) throw new Error("FAI record offsets must increase strictly");
      if (rawOffset(previous, previous.length) > offset) {
        throw new Error(`FAI record '${previous.name}' overlaps '${name}'`);
      }
    }
    rawOffset(record, length);
    names.add(name);
    records.push(record);
  }
  return Object.freeze(records);
}

/** Parses a binary little-endian `.gzi`, adding the format's implicit `(0, 0)` point. */
export function parseGzi(input: ArrayBuffer | Uint8Array): readonly GziCheckpoint[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < GZI_HEADER_BYTES) throw new Error("GZI index is truncated before its entry count");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const countBig = view.getBigUint64(0, true);
  if (countBig > MAX_SAFE_BIGINT) throw new Error("GZI entry count exceeds JavaScript's safe integer range");
  const count = Number(countBig);
  const expectedBytesBig = BigInt(GZI_HEADER_BYTES) + countBig * BigInt(GZI_ENTRY_BYTES);
  if (expectedBytesBig > MAX_SAFE_BIGINT || Number(expectedBytesBig) !== bytes.byteLength) {
    throw new Error(`GZI byte length does not match its declared ${count}-entry count`);
  }

  const checkpoints: GziCheckpoint[] = [
    Object.freeze({ compressedOffset: 0, uncompressedOffset: 0 }),
  ];
  let previousCompressed = 0;
  let previousUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = GZI_HEADER_BYTES + index * GZI_ENTRY_BYTES;
    const compressed = safeBigUint64(view, offset, `GZI entry ${index + 1} compressed offset`);
    const uncompressed = safeBigUint64(view, offset + 8, `GZI entry ${index + 1} uncompressed offset`);
    if (compressed <= previousCompressed || uncompressed <= previousUncompressed) {
      throw new Error("GZI compressed and uncompressed offsets must increase strictly");
    }
    checkpoints.push(Object.freeze({
      compressedOffset: compressed,
      uncompressedOffset: uncompressed,
    }));
    previousCompressed = compressed;
    previousUncompressed = uncompressed;
  }
  return Object.freeze(checkpoints);
}

/** Maps a zero-based base interval to the raw uncompressed FASTA bytes that contain it. */
export function indexedRecordRange(
  record: FaiRecord,
  start = 0,
  end = record.length,
): IndexedRecordRange {
  requireSafeRangeCoordinate(start, "record range start");
  requireSafeRangeCoordinate(end, "record range end");
  if (start > end) throw new RangeError("Indexed FASTA range start exceeds its end");
  if (end > record.length) throw new RangeError(`Indexed FASTA range exceeds record '${record.name}'`);
  return Object.freeze({
    record,
    start,
    end,
    uncompressedStart: rawOffset(record, start),
    uncompressedEnd: rawOffset(record, end),
  });
}

/** Selects complete BGZF members covering an uncompressed FASTA byte interval. */
export function planBgzfRange(
  checkpoints: readonly GziCheckpoint[],
  uncompressedStart: number,
  uncompressedEnd: number,
  compressedFileBytes: number,
): BgzfRangePlan {
  requireSafeRangeCoordinate(uncompressedStart, "BGZF range start");
  requireSafeRangeCoordinate(uncompressedEnd, "BGZF range end");
  requireSafeRangeCoordinate(compressedFileBytes, "BGZF file size");
  if (uncompressedStart > uncompressedEnd) throw new RangeError("BGZF range start exceeds its end");
  validateCheckpoints(checkpoints, compressedFileBytes);

  let startIndex = 0;
  for (let index = 1; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (!checkpoint || checkpoint.uncompressedOffset > uncompressedStart) break;
    startIndex = index;
  }
  const startCheckpoint = checkpoints[startIndex];
  if (!startCheckpoint) throw new Error("GZI index has no implicit origin checkpoint");
  if (uncompressedStart - startCheckpoint.uncompressedOffset > MAX_BGZF_UNCOMPRESSED_BLOCK_BYTES) {
    throw new Error("GZI index is missing a BGZF checkpoint near the requested FASTA range");
  }

  let compressedEnd = compressedFileBytes;
  for (let index = startIndex + 1; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint && checkpoint.uncompressedOffset >= uncompressedEnd) {
      compressedEnd = checkpoint.compressedOffset;
      break;
    }
  }
  if (uncompressedStart !== uncompressedEnd && compressedEnd <= startCheckpoint.compressedOffset) {
    throw new Error("GZI index produced an empty compressed window for a nonempty range");
  }
  return Object.freeze({
    compressedStart: startCheckpoint.compressedOffset,
    compressedEnd,
    checkpointUncompressedOffset: startCheckpoint.uncompressedOffset,
    skipBytes: uncompressedStart - startCheckpoint.uncompressedOffset,
    takeBytes: uncompressedEnd - uncompressedStart,
  });
}

/**
 * Validates and associates a FASTA Blob with its `.fai` and optional BGZF `.gzi`.
 * Ordinary gzip is intentionally rejected because it has no bounded random access.
 */
export async function createIndexedFastaSource(
  file: Blob,
  faiText: string,
  options: IndexedFastaSourceOptions = {},
): Promise<IndexedFastaSource> {
  const records = parseFai(faiText);
  const checkpoints = options.gzi === undefined ? null : parseGzi(options.gzi);
  const gzip = await hasGzipMagic(file);
  if (checkpoints) {
    if (!await isBgzfBlob(file)) throw new Error("A GZI index requires a BGZF FASTA source");
    validateCheckpoints(checkpoints, file.size);
  } else {
    if (gzip) throw new Error("Compressed indexed FASTA requires BGZF input and a matching GZI index");
    validatePlainAssociation(file.size, records);
  }

  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const recordIndexesByName = new Map(records.map((record, index) => [record.name, index]));
  const compression = checkpoints ? "bgzf" as const : "plain" as const;
  return Object.freeze({
    file,
    compression,
    records,
    checkpoints,
    getRecord(name: string): FaiRecord | undefined {
      return recordsByName.get(name);
    },
    async streamFastaRecord(
      name: string,
      streamOptions: Pick<IndexedRecordStreamOptions, "signal"> = {},
    ): Promise<ReadableStream<Uint8Array>> {
      const record = recordsByName.get(name);
      const recordIndex = recordIndexesByName.get(name);
      if (!record || recordIndex === undefined) throw new Error(`FAI does not contain sequence '${name}'`);
      const headerStart = await locateAndValidateFastaHeader(
        file,
        checkpoints,
        records,
        recordIndex,
        streamOptions.signal,
      );
      return rawRangeStream(
        file,
        checkpoints,
        headerStart,
        rawOffset(record, record.length),
        streamOptions.signal,
      );
    },
    streamRecord(name: string, streamOptions: IndexedRecordStreamOptions = {}): ReadableStream<Uint8Array> {
      const record = recordsByName.get(name);
      if (!record) throw new Error(`FAI does not contain sequence '${name}'`);
      const range = indexedRecordRange(record, streamOptions.start, streamOptions.end);
      const requestedBases = range.end - range.start;
      if (streamOptions.maxBases !== undefined) {
        requireSafeRangeCoordinate(streamOptions.maxBases, "maximum indexed FASTA range");
        if (requestedBases > streamOptions.maxBases) {
          throw new RangeError(`Indexed FASTA range contains ${requestedBases} bases, above the ${streamOptions.maxBases}-base caller limit`);
        }
      }
      const raw = checkpoints
        ? bgzfRawRangeStream(file, planBgzfRange(
          checkpoints,
          range.uncompressedStart,
          range.uncompressedEnd,
          file.size,
        ))
        : plainRawRangeStream(
          file,
          range.uncompressedStart,
          range.uncompressedEnd,
          streamOptions.signal,
        );
      return sequenceRangeStream(raw, range, streamOptions.signal);
    },
  });
}

async function locateAndValidateFastaHeader(
  file: Blob,
  checkpoints: readonly GziCheckpoint[] | null,
  records: readonly FaiRecord[],
  recordIndex: number,
  signal?: AbortSignal,
): Promise<number> {
  const record = records[recordIndex];
  if (!record) throw new Error("FAI record index is out of range");
  const previous = records[recordIndex - 1];
  const previousEnd = previous ? rawOffset(previous, previous.length) : 0;
  const requestedStart = Math.max(previousEnd, record.offset - MAX_FASTA_HEADER_LOOKBACK_BYTES);
  const prefix = await collectRawBytes(
    rawRangeStream(file, checkpoints, requestedStart, record.offset, signal),
    signal,
  );
  const located = locateHeaderLine(prefix);
  if (!located) {
    const bounded = requestedStart > previousEnd;
    throw new Error(bounded
      ? `FASTA header for indexed record '${record.name}' exceeds the ${MAX_FASTA_HEADER_LOOKBACK_BYTES.toLocaleString()}-byte validation window`
      : `FASTA bytes before indexed record '${record.name}' do not contain its header line`);
  }
  const decoded = new TextDecoder().decode(prefix.subarray(located.marker + 1, located.end));
  const normalized = decoded.trim();
  const boundary = normalized.search(/\s/u);
  const identifier = boundary < 0 ? normalized : normalized.slice(0, boundary);
  if (identifier !== record.name) {
    throw new Error(
      `FAI record '${record.name}' points to FASTA header '${identifier || "<empty>"}'.`,
    );
  }
  return requestedStart + located.marker;
}

function locateHeaderLine(bytes: Uint8Array): { marker: number; end: number } | null {
  let cursor = bytes.length;
  while (cursor > 0) {
    let end = cursor;
    if (bytes[end - 1] === 0x0a) end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
    let start = end;
    while (start > 0 && bytes[start - 1] !== 0x0a) start -= 1;
    let marker = start;
    while (marker < end && isAsciiHorizontalWhitespace(bytes[marker] ?? 0)) marker += 1;
    if (marker < end) {
      if (bytes[marker] === 0x3b) {
        cursor = start;
        continue;
      }
      return bytes[marker] === 0x3e ? { marker, end } : null;
    }
    cursor = start;
  }
  return null;
}

function isAsciiHorizontalWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0b || byte === 0x0c || byte === 0x20;
}

async function collectRawBytes(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) throw abortError(signal);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = (): void => {
    void reader.cancel(abortError(signal)).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const result = await reader.read();
      if (signal?.aborted) throw abortError(signal);
      if (result.done) break;
      chunks.push(result.value);
      total += result.value.byteLength;
      if (total > MAX_FASTA_HEADER_LOOKBACK_BYTES) {
        throw new Error("Indexed FASTA header validation exceeded its bounded read window");
      }
    }
  } catch (error: unknown) {
    await reader.cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function rawRangeStream(
  file: Blob,
  checkpoints: readonly GziCheckpoint[] | null,
  start: number,
  end: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  return checkpoints
    ? bgzfRawRangeStream(file, planBgzfRange(checkpoints, start, end, file.size))
    : plainRawRangeStream(file, start, end, signal);
}

function rawOffset(record: FaiRecord, baseOffset: number): number {
  const completeLines = Math.floor(baseOffset / record.lineBases);
  const column = baseOffset % record.lineBases;
  const offset = record.offset + completeLines * record.lineWidth + column;
  if (!Number.isSafeInteger(offset)) throw new RangeError(`FAI byte range for '${record.name}' exceeds JavaScript's safe integer range`);
  return offset;
}

function decimalInteger(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} must be an unsigned decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return parsed;
}

function safeBigUint64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > MAX_SAFE_BIGINT) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return Number(value);
}

function requireSafeRangeCoordinate(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative safe integer`);
}

function validatePlainAssociation(fileSize: number, records: readonly FaiRecord[]): void {
  requireSafeRangeCoordinate(fileSize, "FASTA file size");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.offset >= fileSize) throw new Error(`FAI record '${record.name}' starts outside the FASTA file`);
    const end = rawOffset(record, record.length);
    const next = records[index + 1];
    if (next && end > next.offset) throw new Error(`FAI record '${record.name}' overlaps '${next.name}'`);
    const missingFinalTerminatorAllowance = record.length % record.lineBases === 0
      ? record.lineWidth - record.lineBases
      : 0;
    if (!next && end > fileSize + missingFinalTerminatorAllowance) {
      throw new Error(`FAI record '${record.name}' extends beyond the FASTA file`);
    }
  }
}

function validateCheckpoints(checkpoints: readonly GziCheckpoint[], fileSize: number): void {
  if (checkpoints.length === 0) throw new Error("GZI index is missing its implicit origin checkpoint");
  let previousCompressed = -1;
  let previousUncompressed = -1;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (!checkpoint) throw new Error("GZI index contains an empty checkpoint");
    requireSafeRangeCoordinate(checkpoint.compressedOffset, `GZI checkpoint ${index} compressed offset`);
    requireSafeRangeCoordinate(checkpoint.uncompressedOffset, `GZI checkpoint ${index} uncompressed offset`);
    if (index === 0 && (checkpoint.compressedOffset !== 0 || checkpoint.uncompressedOffset !== 0)) {
      throw new Error("GZI checkpoints must begin at the implicit (0, 0) origin");
    }
    if (checkpoint.compressedOffset <= previousCompressed || checkpoint.uncompressedOffset <= previousUncompressed) {
      throw new Error("GZI compressed and uncompressed offsets must increase strictly");
    }
    if (checkpoint.compressedOffset >= fileSize && index > 0) {
      throw new Error(`GZI checkpoint ${index} starts outside the BGZF file`);
    }
    previousCompressed = checkpoint.compressedOffset;
    previousUncompressed = checkpoint.uncompressedOffset;
  }
}

async function hasGzipMagic(file: Blob): Promise<boolean> {
  const prefix = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return prefix[0] === 0x1f && prefix[1] === 0x8b;
}

function plainRawRangeStream(
  file: Blob,
  start: number,
  end: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  if (start === end) return emptyByteStream();
  const boundedEnd = Math.min(end, file.size);
  if (isRangeReadableBlob(file)) {
    return file.streamRange(start, boundedEnd, { signal });
  }
  let position = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (position >= boundedEnd) {
        controller.close();
        return;
      }
      const next = Math.min(boundedEnd, position + INDEXED_STREAM_CHUNK_BYTES);
      const chunk = new Uint8Array(await file.slice(position, next).arrayBuffer());
      position = next;
      controller.enqueue(chunk);
    },
  });
}

function bgzfRawRangeStream(file: Blob, plan: BgzfRangePlan): ReadableStream<Uint8Array> {
  if (plan.takeBytes === 0) return emptyByteStream();
  const compressed = file.slice(plan.compressedStart, plan.compressedEnd)
    .stream() as ReadableStream<Uint8Array>;
  const reader = decompressBgzfStream(compressed).getReader();
  let skip = plan.skipBytes;
  let remaining = plan.takeBytes;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        while (remaining > 0) {
          const result = await reader.read();
          if (result.done) {
            finished = true;
            controller.error(new Error(
              `BGZF FASTA ended ${remaining.toLocaleString()} byte${remaining === 1 ? "" : "s"} before the indexed range.`,
            ));
            return;
          }
          let chunk = result.value;
          if (skip > 0) {
            const skipped = Math.min(skip, chunk.byteLength);
            skip -= skipped;
            chunk = chunk.subarray(skipped);
          }
          if (chunk.byteLength === 0) continue;
          const length = Math.min(remaining, chunk.byteLength);
          remaining -= length;
          controller.enqueue(chunk.subarray(0, length));
          if (remaining === 0) {
            finished = true;
            controller.close();
            await reader.cancel();
          }
          return;
        }
      } catch (error: unknown) {
        finished = true;
        controller.error(error);
      }
    },
    async cancel(reason) {
      finished = true;
      await reader.cancel(reason);
    },
  });
}

function sequenceRangeStream(
  raw: ReadableStream<Uint8Array>,
  range: IndexedRecordRange,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = raw.getReader();
  const expectedBases = range.end - range.start;
  let emittedBases = 0;
  let rawPosition = range.uncompressedStart;
  let finished = false;
  let pendingChunk: Uint8Array | null = null;
  let pendingOffset = 0;
  let controllerReference: ReadableStreamDefaultController<Uint8Array> | null = null;
  const abort = (): void => {
    if (finished) return;
    finished = true;
    const error = abortError(signal);
    void reader.cancel(error).catch(() => undefined);
    controllerReference?.error(error);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerReference = controller;
      if (expectedBases === 0) {
        finished = true;
        controller.close();
        void reader.cancel().catch(() => undefined);
        return;
      }
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      try {
        while (emittedBases < expectedBases) {
          if (!pendingChunk || pendingOffset >= pendingChunk.byteLength) {
            const result = await reader.read();
            if (result.done) {
              throw new Error(`Indexed FASTA range ended after ${emittedBases} of ${expectedBases} bases`);
            }
            pendingChunk = result.value;
            pendingOffset = 0;
          }
          const output = new Uint8Array(Math.min(
            INDEXED_STREAM_CHUNK_BYTES,
            expectedBases - emittedBases,
          ));
          let outputLength = 0;
          while (pendingChunk && pendingOffset < pendingChunk.byteLength && outputLength < output.byteLength) {
            const relative = rawPosition - range.record.offset;
            const linePosition = relative % range.record.lineWidth;
            if (linePosition < range.record.lineBases) {
              const length = Math.min(
                range.record.lineBases - linePosition,
                pendingChunk.byteLength - pendingOffset,
                output.byteLength - outputLength,
                expectedBases - emittedBases,
              );
              const run = pendingChunk.subarray(pendingOffset, pendingOffset + length);
              if (run.indexOf(0x0a) >= 0 || run.indexOf(0x0d) >= 0) {
                throw new Error(`FAI line geometry for '${range.record.name}' places a line ending inside sequence data`);
              }
              output.set(run, outputLength);
              pendingOffset += length;
              rawPosition += length;
              outputLength += length;
              emittedBases += length;
              if (emittedBases === expectedBases) break;
            } else {
              const endingPosition = linePosition - range.record.lineBases;
              const endingBytes = range.record.lineWidth - range.record.lineBases;
              const length = Math.min(
                endingBytes - endingPosition,
                pendingChunk.byteLength - pendingOffset,
              );
              for (let index = 0; index < length; index += 1) {
                const expected = endingBytes === 2 && endingPosition + index === 0
                  ? 0x0d
                  : 0x0a;
                if (pendingChunk[pendingOffset + index] !== expected) {
                  throw new Error(`FAI line geometry for '${range.record.name}' does not match its FASTA bytes`);
                }
              }
              pendingOffset += length;
              rawPosition += length;
            }
          }
          if (outputLength > 0) controller.enqueue(output.subarray(0, outputLength));
          if (emittedBases === expectedBases) {
            finished = true;
            cleanupSignal(signal, abort);
            controller.close();
            await reader.cancel();
            return;
          }
          if (outputLength > 0) return;
        }
      } catch (error: unknown) {
        if (finished) return;
        finished = true;
        cleanupSignal(signal, abort);
        await reader.cancel(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      cleanupSignal(signal, abort);
      await reader.cancel(reason);
    },
  });
}

function emptyByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

function abortError(signal?: AbortSignal): DOMException {
  if (signal?.reason instanceof DOMException && signal.reason.name === "AbortError") return signal.reason;
  return new DOMException("Indexed FASTA read was aborted.", "AbortError");
}

function cleanupSignal(signal: AbortSignal | undefined, listener: () => void): void {
  signal?.removeEventListener("abort", listener);
}
