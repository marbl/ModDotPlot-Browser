/// <reference lib="webworker" />

import init, { ComputeSession } from "./wasm/moddotplot_wasm.js";
import type {
  ComparisonParameters,
  MainToWorkerMessage,
  SequenceMetadata,
  WorkerToMainMessage,
} from "./protocol";
import { transposeTile } from "./tile";

const context = self as DedicatedWorkerGlobalScope;
let session: ComputeSession;
let wasmMemory: WebAssembly.Memory;
let activeGeneration = 0;
let activeTileRequestId = -1;
let activeParameters: ComparisonParameters | null = null;
let loadedSequences: SequenceMetadata[] = [];
const publishedTiles = new Set<string>();
let preparationToken = 0;
let pendingPresentation: {
  generation: number;
  requestId: number;
  resolve: () => void;
} | null = null;

const engineReady = init().then((wasm) => {
  wasmMemory = wasm.memory;
  session = new ComputeSession();
  post({ type: "ready" });
});

context.onmessage = (event: MessageEvent<MainToWorkerMessage>): void => {
  void handleMessage(event.data).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: "error", message });
  });
};

async function handleMessage(message: MainToWorkerMessage): Promise<void> {
  await engineReady;
  switch (message.type) {
    case "load":
      activeGeneration += 1;
      activeTileRequestId = -1;
      activeParameters = null;
      loadedSequences = [];
      publishedTiles.clear();
      releasePresentationWait();
      await loadFiles(message.files);
      break;
    case "prepare":
      activeGeneration = message.generation;
      activeTileRequestId = message.requestId;
      activeParameters = message.parameters;
      publishedTiles.clear();
      releasePresentationWait();
      session.retain_prepared_levels(
        message.parameters.previewRegisterCount,
        message.parameters.detailedRegisterCount,
      );
      await prepareComparison(message.generation, message.requestId, message.parameters);
      break;
    case "cancel-tiles":
      if (message.generation === activeGeneration) {
        activeTileRequestId = message.requestId;
        releasePresentationWait();
      }
      break;
    case "preview-presented":
      if (
        pendingPresentation?.generation === message.generation
        && pendingPresentation.requestId === message.requestId
      ) {
        releasePresentationWait();
      }
      break;
    case "evict-tiles":
      if (message.generation !== activeGeneration) return;
      for (const tile of message.tiles) forgetPublishedTile(tile.resolution, tile.x, tile.y);
      break;
    case "request-tiles":
      if (message.generation !== activeGeneration || !activeParameters) return;
      activeTileRequestId = message.requestId;
      await computeRequestedTiles(
        message.generation,
        message.requestId,
        message.resolution,
        message.mode,
        message.tiles,
        activeParameters,
      );
      break;
    case "clear":
      activeGeneration += 1;
      activeTileRequestId = -1;
      activeParameters = null;
      loadedSequences = [];
      publishedTiles.clear();
      releasePresentationWait();
      session.clear();
      break;
  }
}

async function loadFiles(files: File[]): Promise<void> {
  session.clear();
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  let completedBytes = 0;
  for (const file of files) {
    session.begin_fasta();
    let stream: ReadableStream<Uint8Array> = file.stream();
    const compressedFile = file.name.toLowerCase().endsWith(".gz");
    if (compressedFile) {
      if (!("DecompressionStream" in globalThis)) {
        throw new Error("This browser cannot decompress gzip FASTA files; use an uncompressed FASTA.");
      }
      let compressedBytes = 0;
      stream = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          compressedBytes += chunk.byteLength;
          const progress = totalBytes > 0
            ? (completedBytes + Math.min(compressedBytes, file.size)) / totalBytes
            : 0;
          post({ type: "status", text: `Reading ${file.name}`, progress, busy: true });
          controller.enqueue(chunk);
        },
      }));
      // lib.dom types DecompressionStream as BufferSource even though browser file
      // streams yield Uint8Array chunks. The runtime types are identical here.
      const compressed = stream as unknown as ReadableStream<BufferSource>;
      stream = compressed.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
    }
    const reader = stream.getReader();
    let fileBytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      session.push_fasta_chunk(result.value);
      fileBytes += result.value.byteLength;
      if (!compressedFile) {
        const progress = totalBytes > 0
          ? (completedBytes + Math.min(fileBytes, file.size)) / totalBytes
          : 0;
        post({ type: "status", text: `Reading ${file.name}`, progress, busy: true });
      }
    }
    session.finish_fasta();
    completedBytes += file.size;
  }
  const raw = session.sequences() as Array<{ index: number; name: string; length: number | bigint }>;
  loadedSequences = raw.map((sequence) => ({
    index: sequence.index,
    name: sequence.name,
    length: Number(sequence.length),
  }));
  post({ type: "sequences", sequences: loadedSequences });
  post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
}

async function prepareComparison(
  generation: number,
  requestId: number,
  parameters: ComparisonParameters,
): Promise<void> {
  const started = performance.now();
  const distinctPasses = parameters.previewRegisterCount < parameters.detailedRegisterCount;
  const firstRegisters = distinctPasses
    ? parameters.previewRegisterCount
    : parameters.detailedRegisterCount;
  const firstQuality = distinctPasses ? "preview" : "refined";
  const firstPrepared = await prepareOverviewLevel(
    generation,
    requestId,
    parameters,
    firstRegisters,
    !distinctPasses,
  );
  if (!firstPrepared) return;
  post({ type: "comparison-ready", generation, parameters });
  await computeLevel(
    generation,
    requestId,
    parameters,
    firstRegisters,
    firstQuality,
  );
  if (!isCurrentTileRequest(generation, requestId)) return;
  if (distinctPasses) {
    await waitForPreviewPresentation(generation, requestId);
    if (!isCurrentTileRequest(generation, requestId)) return;
    const detailedPrepared = await prepareOverviewLevel(
      generation,
      requestId,
      parameters,
      parameters.detailedRegisterCount,
      true,
    );
    if (!detailedPrepared) return;
    await computeLevel(
      generation,
      requestId,
      parameters,
      parameters.detailedRegisterCount,
      "refined",
    );
  }
  if (!isCurrentTileRequest(generation, requestId)) return;
  post({
    type: "complete",
    generation,
    elapsedMs: performance.now() - started,
    estimatedBytes: allocatedWorkerBytes(),
  });
}

async function prepareOverviewLevel(
  generation: number,
  requestId: number,
  parameters: ComparisonParameters,
  registerCount: number,
  adaptive: boolean,
): Promise<boolean> {
  const label = adaptive ? "Building high-detail signatures" : "Building quick signatures";
  post({ type: "status", text: label, progress: 0, busy: true });
  if (adaptive) {
    session.begin_prepare_comparison(
      parameters.xIndex,
      parameters.yIndex,
      parameters.resolution,
      registerCount,
      12,
      parameters.k,
    );
  } else {
    session.begin_prepare_preview(
      parameters.xIndex,
      parameters.yIndex,
      parameters.resolution,
      registerCount,
      12,
      parameters.k,
    );
  }
  const token = ++preparationToken;
  let progress = 0;
  const chunkBins = Math.max(16, Math.min(64, Math.ceil(parameters.resolution / 16)));
  while (progress < 1) {
    if (!isCurrentTileRequest(generation, requestId)) {
      if (token === preparationToken) session.cancel_preparation();
      return false;
    }
    progress = session.prepare_comparison_chunk(chunkBins);
    post({ type: "status", text: label, progress, busy: true });
    await yieldToMessages();
  }
  return isCurrentTileRequest(generation, requestId);
}

async function computeLevel(
  generation: number,
  requestId: number,
  parameters: ComparisonParameters,
  registerLimit: number,
  quality: "preview" | "refined",
): Promise<void> {
  const tileSize = 256;
  const tilesPerAxis = Math.ceil(parameters.resolution / tileSize);
  const selfComparison = parameters.xIndex === parameters.yIndex;
  const total = selfComparison
    ? (tilesPerAxis * (tilesPerAxis + 1)) / 2
    : tilesPerAxis * tilesPerAxis;
  let completed = 0;
  for (let y = 0; y < parameters.resolution; y += tileSize) {
    const firstX = selfComparison ? y : 0;
    for (let x = firstX; x < parameters.resolution; x += tileSize) {
      if (!isCurrentTileRequest(generation, requestId)) return;
      const tile = session.compute_tile(
        x,
        y,
        tileSize,
        tileSize,
        14,
        registerLimit,
        quality === "refined",
      );
      const identity = tile.identity().slice();
      const direction = tile.direction().slice();
      const directionSupport = tile.direction_support().slice();
      const width = tile.width;
      const height = tile.height;
      tile.free();
      const mirror = selfComparison && x !== y
        ? transposeTile(identity, direction, directionSupport, width, height)
        : null;
      context.postMessage(
        {
          type: "tile",
          generation,
          quality,
          resolution: parameters.resolution,
          x,
          y,
          width,
          height,
          identity,
          direction,
          directionSupport,
        },
        [identity.buffer, direction.buffer, directionSupport.buffer],
      );
      publishedTiles.add(`${parameters.resolution}:${x}:${y}:${quality}`);
      if (mirror) {
        context.postMessage(
          {
            type: "tile",
            generation,
            quality,
            resolution: parameters.resolution,
            x: y,
            y: x,
            width: mirror.width,
            height: mirror.height,
            identity: mirror.identity,
            direction: mirror.direction,
            directionSupport: mirror.directionSupport,
          },
          [mirror.identity.buffer, mirror.direction.buffer, mirror.directionSupport.buffer],
        );
        publishedTiles.add(`${parameters.resolution}:${y}:${x}:${quality}`);
      }
      completed += 1;
      post({
        type: "status",
        text: quality === "preview" ? "Drawing quick overview" : "Refining overview",
        progress: completed / total,
        busy: true,
      });
      await yieldToMessages();
    }
  }
}

async function computeRequestedTiles(
  generation: number,
  requestId: number,
  resolution: number,
  mode: "sketch" | "kmer",
  tiles: Array<{ x: number; y: number }>,
  parameters: ComparisonParameters,
): Promise<void> {
  if (tiles.length === 0) return;
  if (mode === "kmer") {
    await computeExactRequestedTiles(
      generation,
      requestId,
      resolution,
      tiles,
      parameters,
    );
    return;
  }
  const selfComparison = parameters.xIndex === parameters.yIndex;
  const distinctPasses = parameters.previewRegisterCount < parameters.detailedRegisterCount;
  const firstRegisters = distinctPasses
    ? parameters.previewRegisterCount
    : parameters.detailedRegisterCount;
  const firstQuality = distinctPasses ? "preview" : "refined";
  await computeRequestedLevel(
    generation,
    requestId,
    resolution,
    tiles,
    firstRegisters,
    firstQuality,
    selfComparison,
  );
  if (distinctPasses && isCurrentTileRequest(generation, requestId)) {
    await waitForPreviewPresentation(generation, requestId);
    if (!isCurrentTileRequest(generation, requestId)) return;
    if (
      resolution === parameters.resolution
      && !session.has_prepared_level(parameters.detailedRegisterCount)
    ) {
      const prepared = await prepareOverviewLevel(
        generation,
        requestId,
        parameters,
        parameters.detailedRegisterCount,
        true,
      );
      if (!prepared) return;
    }
    await computeRequestedLevel(
      generation,
      requestId,
      resolution,
      tiles,
      parameters.detailedRegisterCount,
      "refined",
      selfComparison,
    );
  }
  if (isCurrentTileRequest(generation, requestId)) {
    post({ type: "status", text: `Ready · ${resolution.toLocaleString()}-cell detail cached` });
    post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
  }
}

async function computeExactRequestedTiles(
  generation: number,
  requestId: number,
  resolution: number,
  tiles: Array<{ x: number; y: number }>,
  parameters: ComparisonParameters,
): Promise<void> {
  const selfComparison = parameters.xIndex === parameters.yIndex;
  let completed = 0;
  for (const coordinate of tiles) {
    if (!isCurrentTileRequest(generation, requestId)) return;
    const key = `${resolution}:${coordinate.x}:${coordinate.y}:exact`;
    if (!publishedTiles.has(key)) {
      const tile = session.compute_kmer_tile(
        BigInt(coordinate.x),
        BigInt(coordinate.y),
        256,
        256,
      );
      const identity = tile.identity().slice();
      const direction = tile.direction().slice();
      const directionSupport = tile.direction_support().slice();
      const width = tile.width;
      const height = tile.height;
      tile.free();
      const xBases = readBaseCodes(parameters.xIndex, coordinate.x, width);
      const mirror = selfComparison && coordinate.x !== coordinate.y
        ? transposeTile(identity, direction, directionSupport, width, height)
        : null;
      const yBases = mirror
        ? readBaseCodes(parameters.yIndex, coordinate.y, height)
        : null;
      context.postMessage(
        {
          type: "tile",
          generation,
          quality: "exact",
          resolution,
          x: coordinate.x,
          y: coordinate.y,
          width,
          height,
          identity,
          direction,
          directionSupport,
          bases: xBases,
        },
        [identity.buffer, direction.buffer, directionSupport.buffer, xBases.buffer],
      );
      publishedTiles.add(key);
      if (mirror) {
        context.postMessage(
          {
            type: "tile",
            generation,
            quality: "exact",
            resolution,
            x: coordinate.y,
            y: coordinate.x,
            width: mirror.width,
            height: mirror.height,
            identity: mirror.identity,
            direction: mirror.direction,
            directionSupport: mirror.directionSupport,
            bases: yBases!,
          },
          [
            mirror.identity.buffer,
            mirror.direction.buffer,
            mirror.directionSupport.buffer,
            yBases!.buffer,
          ],
        );
        publishedTiles.add(`${resolution}:${coordinate.y}:${coordinate.x}:exact`);
      }
    }
    completed += 1;
    post({
      type: "status",
      text: "Drawing exact k-mers",
      progress: completed / tiles.length,
      busy: true,
    });
    await yieldToMessages();
  }
  if (isCurrentTileRequest(generation, requestId)) {
    post({ type: "status", text: "Ready · exact k-mer detail cached" });
    post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
  }
}

async function computeRequestedLevel(
  generation: number,
  requestId: number,
  resolution: number,
  tiles: Array<{ x: number; y: number }>,
  registerLimit: number,
  quality: "preview" | "refined",
  selfComparison: boolean,
): Promise<void> {
  let completed = 0;
  for (const coordinate of tiles) {
    if (!isCurrentTileRequest(generation, requestId)) return;
    const key = `${resolution}:${coordinate.x}:${coordinate.y}:${quality}`;
    if (!publishedTiles.has(key)) {
      const tile = resolution === parametersResolution()
        ? session.compute_tile(
            coordinate.x,
            coordinate.y,
            256,
            256,
            14,
            registerLimit,
            quality === "refined",
          )
        : session.compute_zoom_tile(
            resolution,
            coordinate.x,
            coordinate.y,
            256,
            256,
            14,
            registerLimit,
            quality === "refined",
          );
      const identity = tile.identity().slice();
      const direction = tile.direction().slice();
      const directionSupport = tile.direction_support().slice();
      const width = tile.width;
      const height = tile.height;
      tile.free();
      const mirror = selfComparison && coordinate.x !== coordinate.y
        ? transposeTile(identity, direction, directionSupport, width, height)
        : null;
      context.postMessage(
        {
          type: "tile",
          generation,
          quality,
          resolution,
          x: coordinate.x,
          y: coordinate.y,
          width,
          height,
          identity,
          direction,
          directionSupport,
        },
        [identity.buffer, direction.buffer, directionSupport.buffer],
      );
      publishedTiles.add(key);
      if (mirror) {
        context.postMessage(
          {
            type: "tile",
            generation,
            quality,
            resolution,
            x: coordinate.y,
            y: coordinate.x,
            width: mirror.width,
            height: mirror.height,
            identity: mirror.identity,
            direction: mirror.direction,
            directionSupport: mirror.directionSupport,
          },
          [mirror.identity.buffer, mirror.direction.buffer, mirror.directionSupport.buffer],
        );
        publishedTiles.add(`${resolution}:${coordinate.y}:${coordinate.x}:${quality}`);
      }
    }
    completed += 1;
    post({
      type: "status",
      text: quality === "preview" ? "Drawing quick detail" : "Refining zoom detail",
      progress: completed / Math.max(1, tiles.length),
      busy: true,
    });
    await yieldToMessages();
  }
}

function parametersResolution(): number {
  if (!activeParameters) throw new Error("No active comparison parameters");
  return activeParameters.resolution;
}

function readBaseCodes(sequenceIndex: number, start: number, count: number): Uint8Array {
  const result = new Uint8Array(count);
  result.fill(4);
  const metadata = loadedSequences.find((sequence) => sequence.index === sequenceIndex);
  if (!metadata || start >= metadata.length) return result;
  const end = Math.min(metadata.length, start + count);
  const ascii = session.sequence_ascii(sequenceIndex, BigInt(start), BigInt(end));
  for (let index = 0; index < ascii.length; index += 1) {
    result[index] = ascii[index] === 65
      ? 0
      : ascii[index] === 67
        ? 1
        : ascii[index] === 71
          ? 2
          : ascii[index] === 84
            ? 3
            : 4;
  }
  return result;
}

function waitForPreviewPresentation(generation: number, requestId: number): Promise<void> {
  releasePresentationWait();
  return new Promise((resolve) => {
    pendingPresentation = { generation, requestId, resolve };
    post({ type: "preview-complete", generation, requestId });
  });
}

function releasePresentationWait(): void {
  const pending = pendingPresentation;
  pendingPresentation = null;
  pending?.resolve();
}

function forgetPublishedTile(resolution: number, x: number, y: number): void {
  for (const quality of ["preview", "refined", "exact"] as const) {
    publishedTiles.delete(`${resolution}:${x}:${y}:${quality}`);
  }
}

function allocatedWorkerBytes(): number {
  return Math.max(session.estimated_memory_bytes(), wasmMemory.buffer.byteLength);
}

function isCurrentTileRequest(generation: number, requestId: number): boolean {
  return generation === activeGeneration && requestId === activeTileRequestId;
}

function yieldToMessages(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function post(message: WorkerToMainMessage): void {
  context.postMessage(message);
}
