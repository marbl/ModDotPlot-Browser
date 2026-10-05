import type { RangeReadableBlob } from "./indexed-fasta";

const PROBE_BYTES = 2;
const MAX_STREAM_CHUNK_BYTES = 64 * 1024;

export type HttpRangeFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateHttpRangeBlobOptions {
  /** Base document URL used both to resolve relative paths and enforce same-origin access. */
  readonly baseUrl?: string | URL;
  /** Injectable for deterministic tests. Production callers normally use `fetch`. */
  readonly fetcher?: HttpRangeFetcher;
  /** Cancels the initial two-byte range probe. */
  readonly signal?: AbortSignal;
  readonly mediaType?: string;
}

interface RemoteDescriptor {
  readonly url: URL;
  readonly origin: string;
  readonly size: number;
  readonly fetcher: HttpRangeFetcher;
  readonly prefix: Uint8Array;
  readonly validator: string | null;
}

interface ParsedContentRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

/**
 * A same-origin Blob facade backed by validated HTTP byte-range requests.
 *
 * `slice()` remains lazy. Reading a slice issues one exact Range request and streams
 * its body with backpressure instead of allocating or downloading the complete file.
 */
export class HttpRangeBlob extends Blob implements RangeReadableBlob {
  readonly #descriptor: RemoteDescriptor;
  readonly #start: number;
  readonly #end: number;

  private constructor(
    descriptor: RemoteDescriptor,
    start: number,
    end: number,
    mediaType: string,
  ) {
    super([], { type: normalizeMediaType(mediaType) });
    this.#descriptor = descriptor;
    this.#start = start;
    this.#end = end;
  }

  static fromVerifiedDescriptor(
    descriptor: RemoteDescriptor,
    mediaType: string,
  ): HttpRangeBlob {
    return new HttpRangeBlob(descriptor, 0, descriptor.size, mediaType);
  }

  override get size(): number {
    return this.#end - this.#start;
  }

  get url(): string {
    return this.#descriptor.url.href;
  }

  override slice(start?: number, end?: number, contentType = ""): Blob {
    const relativeStart = normalizeSliceCoordinate(start, this.size, 0);
    const relativeEnd = normalizeSliceCoordinate(end, this.size, this.size);
    const boundedEnd = Math.max(relativeStart, relativeEnd);
    return new HttpRangeBlob(
      this.#descriptor,
      this.#start + relativeStart,
      this.#start + boundedEnd,
      contentType,
    );
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.streamRange(0, this.size) as ReadableStream<Uint8Array<ArrayBuffer>>;
  }

  streamRange(
    start: number,
    end: number,
    options: { readonly signal?: AbortSignal } = {},
  ): ReadableStream<Uint8Array> {
    requireRangeCoordinate(start, "HTTP range start");
    requireRangeCoordinate(end, "HTTP range end");
    if (start > end) throw new RangeError("HTTP range start exceeds its end");
    if (end > this.size) throw new RangeError("HTTP range exceeds the remote Blob");
    if (start === end) return emptyByteStream();

    const absoluteStart = this.#start + start;
    const absoluteEnd = this.#start + end;
    if (absoluteStart >= 0 && absoluteEnd <= this.#descriptor.prefix.byteLength) {
      const cached = this.#descriptor.prefix.slice(absoluteStart, absoluteEnd);
      return oneChunkStream(cached, options.signal);
    }
    return validatedRangeStream(
      this.#descriptor,
      absoluteStart,
      absoluteEnd,
      options.signal,
    );
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return (await collectBytes(this.stream())).buffer;
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return collectBytes(this.stream());
  }

  override async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }
}

/**
 * Probes a same-origin URL with `Range: bytes=0-1` and returns a lazy remote Blob.
 * A server that returns `200 OK` is rejected before its response body is consumed.
 */
export async function createHttpRangeBlob(
  input: string | URL,
  options: CreateHttpRangeBlobOptions = {},
): Promise<HttpRangeBlob> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const url = new URL(input.toString(), baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new Error(
      `Remote FASTA must be same-origin (${baseUrl.origin}); received ${url.origin}.`,
    );
  }
  options.signal?.throwIfAborted();
  const sourceFetcher = options.fetcher ?? globalThis.fetch;
  // WorkerGlobalScope.fetch is brand-checked in WebKit/Safari. Keep one wrapper in
  // the descriptor so both the probe and later lazy ranges call it with the worker
  // global as `this`, rather than as an unbound function or descriptor method.
  const fetcher: HttpRangeFetcher = (request, init) => (
    sourceFetcher.call(globalThis, request, init)
  );
  const response = await fetcher(url, {
    method: "GET",
    headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    credentials: "same-origin",
    redirect: "error",
    signal: options.signal,
  });
  const parsed = await validateRangeResponse(
    response,
    url,
    0,
    PROBE_BYTES,
    undefined,
  );
  if (parsed.total < PROBE_BYTES) {
    await response.body?.cancel();
    throw new Error("Remote FASTA is too short to contain a valid FASTA record.");
  }
  const prefix = await readResponseExactly(response, PROBE_BYTES, options.signal);
  const descriptor: RemoteDescriptor = Object.freeze({
    url,
    origin: baseUrl.origin,
    size: parsed.total,
    fetcher,
    prefix,
    validator: responseValidator(response),
  });
  return HttpRangeBlob.fromVerifiedDescriptor(descriptor, options.mediaType ?? "text/plain");
}

function validatedRangeStream(
  descriptor: RemoteDescriptor,
  start: number,
  end: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const expectedBytes = end - start;
  const requestController = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let initialization: Promise<void> | null = null;
  let received = 0;
  let pendingChunk: Uint8Array | null = null;
  let pendingOffset = 0;
  let finished = false;
  let controllerReference: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = (): void => signal?.removeEventListener("abort", abort);
  const abort = (): void => {
    if (finished) return;
    requestController.abort(abortError(signal));
    void reader?.cancel(abortError(signal)).catch(() => undefined);
    if (controllerReference) {
      finished = true;
      cleanup();
      controllerReference.error(abortError(signal));
    }
  };
  const initialize = async (): Promise<void> => {
    const headers = new Headers({ Range: `bytes=${start}-${end - 1}` });
    if (descriptor.validator) headers.set("If-Range", descriptor.validator);
    const response = await descriptor.fetcher(descriptor.url, {
      method: "GET",
      headers,
      credentials: "same-origin",
      redirect: "error",
      signal: requestController.signal,
    });
    await validateRangeResponse(
      response,
      descriptor.url,
      start,
      end,
      descriptor.size,
    );
    if (!response.body) throw new Error("HTTP Range response has no readable body.");
    reader = response.body.getReader();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerReference = controller;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      try {
        initialization ??= initialize();
        await initialization;
        if (signal?.aborted) throw abortError(signal);
        while (!finished) {
          if (pendingChunk && pendingOffset < pendingChunk.byteLength) {
            const next = Math.min(
              pendingChunk.byteLength,
              pendingOffset + MAX_STREAM_CHUNK_BYTES,
            );
            controller.enqueue(pendingChunk.subarray(pendingOffset, next));
            pendingOffset = next;
            if (pendingOffset === pendingChunk.byteLength) {
              pendingChunk = null;
              pendingOffset = 0;
              if (received === expectedBytes) {
                const trailing = await reader!.read();
                if (!trailing.done) {
                  throw new Error("HTTP Range response body exceeds its declared Content-Range.");
                }
                finished = true;
                cleanup();
                controller.close();
              }
            }
            return;
          }

          const result = await reader!.read();
          if (result.done) {
            if (received !== expectedBytes) {
              throw new Error(
                `HTTP Range response ended after ${received.toLocaleString()} of ${expectedBytes.toLocaleString()} bytes.`,
              );
            }
            finished = true;
            cleanup();
            controller.close();
            return;
          }
          if (received + result.value.byteLength > expectedBytes) {
            throw new Error("HTTP Range response body exceeds its declared Content-Range.");
          }
          received += result.value.byteLength;
          if (result.value.byteLength === 0) continue;
          pendingChunk = result.value;
        }
      } catch (error: unknown) {
        if (finished) return;
        finished = true;
        cleanup();
        requestController.abort(error);
        await reader?.cancel(error).catch(() => undefined);
        controller.error(signal?.aborted ? abortError(signal) : error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      cleanup();
      requestController.abort(reason);
      await reader?.cancel(reason);
    },
  });
}

async function validateRangeResponse(
  response: Response,
  requestedUrl: URL,
  expectedStart: number,
  expectedEnd: number,
  expectedTotal?: number,
): Promise<ParsedContentRange> {
  if (response.status !== 206) {
    await response.body?.cancel();
    if (response.status === 200) {
      throw new Error(
        "Remote FASTA server ignored the HTTP Range request; refusing to download the complete file.",
      );
    }
    throw new Error(`Remote FASTA range request failed with HTTP ${response.status}.`);
  }
  if (response.url) {
    const responseUrl = new URL(response.url);
    if (responseUrl.origin !== requestedUrl.origin) {
      await response.body?.cancel();
      throw new Error("Remote FASTA range request redirected to another origin.");
    }
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLocaleLowerCase("en-US") !== "identity") {
    await response.body?.cancel();
    throw new Error(
      "Remote FASTA range responses must use identity Content-Encoding so FAI byte offsets remain valid.",
    );
  }
  let parsed: ParsedContentRange;
  try {
    parsed = parseContentRange(response.headers.get("content-range"));
  } catch (error: unknown) {
    await response.body?.cancel();
    throw error;
  }
  if (parsed.start !== expectedStart || parsed.end + 1 !== expectedEnd) {
    await response.body?.cancel();
    throw new Error(
      `Remote FASTA returned Content-Range bytes ${parsed.start}-${parsed.end}; expected bytes ${expectedStart}-${expectedEnd - 1}.`,
    );
  }
  if (expectedTotal !== undefined && parsed.total !== expectedTotal) {
    await response.body?.cancel();
    throw new Error(
      `Remote FASTA size changed from ${expectedTotal.toLocaleString()} to ${parsed.total.toLocaleString()} bytes.`,
    );
  }
  const expectedBytes = expectedEnd - expectedStart;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    let parsedLength: number;
    try {
      parsedLength = decimalHeader(contentLength, "Content-Length");
    } catch (error: unknown) {
      await response.body?.cancel();
      throw error;
    }
    if (parsedLength !== expectedBytes) {
      await response.body?.cancel();
      throw new Error("Remote FASTA Content-Length does not match its Content-Range.");
    }
  }
  if (!response.body) throw new Error("HTTP Range response has no readable body.");
  return parsed;
}

function parseContentRange(value: string | null): ParsedContentRange {
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/u.exec(value ?? "");
  if (!match) throw new Error("Remote FASTA response has an invalid Content-Range header.");
  const start = decimalHeader(match[1]!, "Content-Range start");
  const end = decimalHeader(match[2]!, "Content-Range end");
  const total = decimalHeader(match[3]!, "Content-Range total");
  if (start > end || end >= total) {
    throw new Error("Remote FASTA response has an impossible Content-Range header.");
  }
  return { start, end, total };
}

async function readResponseExactly(
  response: Response,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body!.getReader();
  const output = new Uint8Array(expectedBytes);
  let offset = 0;
  const abort = (): void => {
    void reader.cancel(abortError(signal)).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const result = await reader.read();
      if (result.done) break;
      if (offset + result.value.byteLength > expectedBytes) {
        throw new Error("HTTP Range response body exceeds its declared Content-Range.");
      }
      output.set(result.value, offset);
      offset += result.value.byteLength;
    }
    if (offset !== expectedBytes) {
      throw new Error(
        `HTTP Range response ended after ${offset.toLocaleString()} of ${expectedBytes.toLocaleString()} bytes.`,
      );
    }
    return output;
  } catch (error: unknown) {
    await reader.cancel(error).catch(() => undefined);
    throw signal?.aborted ? abortError(signal) : error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function collectBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
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

function responseValidator(response: Response): string | null {
  const etag = response.headers.get("etag");
  if (etag && !/^W\//iu.test(etag)) return etag;
  return response.headers.get("last-modified");
}

function resolveBaseUrl(value?: string | URL): URL {
  if (value instanceof URL) return value;
  if (value !== undefined) return new URL(value);
  if (typeof globalThis.location !== "undefined") return new URL(globalThis.location.href);
  throw new Error("A baseUrl is required to enforce same-origin remote FASTA access.");
}

function normalizeMediaType(value: string): string {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e;
  }) ? value.toLocaleLowerCase("en-US") : "";
}

function normalizeSliceCoordinate(
  value: number | undefined,
  size: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const integer = Number.isNaN(value) ? 0 : Math.trunc(value);
  if (integer < 0) return Math.max(size + integer, 0);
  return Math.min(integer, size);
}

function decimalHeader(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`Remote FASTA ${label} is not an unsigned decimal integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Remote FASTA ${label} exceeds JavaScript's safe integer range.`);
  }
  return parsed;
}

function requireRangeCoordinate(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
}

function emptyByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.close(); },
  });
}

function oneChunkStream(
  bytes: Uint8Array,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal?.aborted) {
        controller.error(abortError(signal));
        return;
      }
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function abortError(signal?: AbortSignal): DOMException {
  if (signal?.reason instanceof DOMException && signal.reason.name === "AbortError") {
    return signal.reason;
  }
  return new DOMException("Remote FASTA range read was aborted.", "AbortError");
}
