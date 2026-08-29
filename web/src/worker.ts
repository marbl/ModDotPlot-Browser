/// <reference lib="webworker" />

import init, { ComputeSession, ScientificConfig } from "./wasm/moddotplot_wasm.js";
import type {
  ComparisonParameters,
  FeatureTrackRequest,
  MainToWorkerMessage,
  ScientificConfigMetadata,
  SequenceMetadata,
  WorkerToMainMessage,
} from "./protocol";
import { transposeTile } from "./tile";
import {
  refinementKey,
  selectRefinementTiles,
  tileRefinementPriority,
} from "./refinement";

const context = self as DedicatedWorkerGlobalScope;
let session: ComputeSession;
let wasmMemory: WebAssembly.Memory;
let activeGeneration = 0;
let activeTileRequestId = -1;
let activeFeatureTrackRequestId = -1;
let activeParameters: ComparisonParameters | null = null;
let loadedSequences: SequenceMetadata[] = [];
const scientificConfigs = new Map<number, ScientificConfig>();
const publishedTiles = new Set<string>();
const refinementPriority = new Map<string, number>();
let preparationToken = 0;
let operationEpoch = 0;
let executingEpoch = 0;
let messageQueue = Promise.resolve();
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
  const message = event.data;
  if (message.type === "preview-presented") {
    if (
      pendingPresentation?.generation === message.generation
      && pendingPresentation.requestId === message.requestId
    ) {
      releasePresentationWait();
    }
    return;
  }
  if (message.type === "cancel-tiles") {
    operationEpoch += 1;
    if (message.generation === activeGeneration) {
      activeTileRequestId = message.requestId;
      releasePresentationWait();
    }
    return;
  }
  if (message.type === "evict-tiles") {
    if (message.generation === activeGeneration) {
      for (const tile of message.tiles) forgetPublishedTile(tile.resolution, tile.x, tile.y);
    }
    return;
  }
  if (message.type === "cancel-feature-tracks") {
    if (message.generation === activeGeneration) activeFeatureTrackRequestId = message.requestId;
    return;
  }
  if (message.type === "request-feature-tracks") {
    activeFeatureTrackRequestId = message.requestId;
    const ticket = operationEpoch;
    messageQueue = messageQueue.then(async () => {
      if (ticket !== operationEpoch) return;
      executingEpoch = ticket;
      await engineReady;
      await computeFeatureTracks(message.generation, message.requestId, message.tracks);
    }).catch((error: unknown) => {
      if (ticket !== operationEpoch || message.requestId !== activeFeatureTrackRequestId) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      post({ type: "error", message: errorMessage });
    });
    return;
  }
  const ticket = ++operationEpoch;
  messageQueue = messageQueue.then(async () => {
    executingEpoch = ticket;
    await handleMessage(message);
  }).catch((error: unknown) => {
    if (ticket !== operationEpoch) return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    post({ type: "error", message: errorMessage });
  });
};

async function handleMessage(message: MainToWorkerMessage): Promise<void> {
  await engineReady;
  switch (message.type) {
    case "load":
      activeGeneration = message.generation;
      activeTileRequestId = -1;
      activeFeatureTrackRequestId = -1;
      activeParameters = null;
      publishedTiles.clear();
      refinementPriority.clear();
      releasePresentationWait();
      await loadFiles(message.files, message.generation);
      break;
    case "prepare":
      activeGeneration = message.generation;
      activeTileRequestId = message.requestId;
      activeParameters = message.parameters;
      publishedTiles.clear();
      refinementPriority.clear();
      releasePresentationWait();
      releaseScientificConfigs();
      if (message.parameters.previewRegisterCount < message.parameters.detailedRegisterCount) {
        scientificConfigs.set(
          message.parameters.previewRegisterCount,
          new ScientificConfig(message.parameters.k, message.parameters.previewRegisterCount, false),
        );
      }
      scientificConfigs.set(
        message.parameters.detailedRegisterCount,
        new ScientificConfig(
          message.parameters.k,
          message.parameters.detailedRegisterCount,
          message.parameters.sparseCorrection,
        ),
      );
      session.retain_prepared_levels(
        message.parameters.previewRegisterCount,
        message.parameters.detailedRegisterCount,
      );
      await prepareComparison(message.generation, message.requestId, message.parameters);
      break;
    case "cancel-tiles":
    case "preview-presented":
    case "evict-tiles":
    case "cancel-feature-tracks":
    case "request-feature-tracks":
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
      activeGeneration = message.generation;
      activeTileRequestId = -1;
      activeFeatureTrackRequestId = -1;
      activeParameters = null;
      loadedSequences = [];
      publishedTiles.clear();
      refinementPriority.clear();
      releasePresentationWait();
      releaseScientificConfigs();
      session.clear();
      break;
  }
}

async function computeFeatureTracks(
  generation: number,
  requestId: number,
  tracks: FeatureTrackRequest[],
): Promise<void> {
  if (!isCurrentFeatureTrackRequest(generation, requestId) || tracks.length === 0) return;
  const sequenceIndexes = [...new Set(tracks.map((track) => track.sequenceIndex))];
  const totalBases = Math.max(1, sequenceIndexes.reduce((total, sequenceIndex) =>
    total + (loadedSequences.find((sequence) => sequence.index === sequenceIndex)?.length ?? 0), 0));
  let completedBases = 0;

  for (const sequenceIndex of sequenceIndexes) {
    if (!isCurrentFeatureTrackRequest(generation, requestId)) return;
    const metadata = loadedSequences.find((sequence) => sequence.index === sequenceIndex);
    if (!metadata) throw new Error("A selected feature-track sequence is no longer loaded.");
    let ready = session.begin_composition_index(sequenceIndex);
    let progress = ready ? 1 : 0;
    while (!ready) {
      if (!isCurrentFeatureTrackRequest(generation, requestId)) return;
      progress = session.prepare_composition_index_chunk(sequenceIndex, 2_048);
      ready = progress >= 1;
      post({
        type: "feature-track-status",
        generation,
        requestId,
        text: `Computing sequence tracks · ${metadata.name}`,
        progress: (completedBases + progress * metadata.length) / totalBases,
      });
      await yieldToMessages();
    }
    completedBases += metadata.length;
  }

  if (!isCurrentFeatureTrackRequest(generation, requestId)) return;
  const payloads = tracks.map((track) => ({
    kind: track.kind,
    axis: track.axis,
    start: Math.floor(track.start),
    end: Math.ceil(track.end),
    values: track.kind === "gc"
      ? session.gc_bins(
          track.sequenceIndex,
          BigInt(Math.floor(track.start)),
          BigInt(Math.ceil(track.end)),
          track.bins,
        )
      : session.cpg_observed_expected_bins(
          track.sequenceIndex,
          BigInt(Math.floor(track.start)),
          BigInt(Math.ceil(track.end)),
          track.bins,
        ),
  }));
  if (!isCurrentFeatureTrackRequest(generation, requestId)) return;
  context.postMessage(
    {
      type: "feature-tracks",
      generation,
      requestId,
      tracks: payloads,
      estimatedBytes: allocatedWorkerBytes(),
    },
    payloads.map((payload) => payload.values.buffer),
  );
}

async function loadFiles(files: File[], generation: number): Promise<void> {
  const staging = new ComputeSession();
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  let completedBytes = 0;
  try {
    for (const file of files) {
      if (!operationIsCurrent()) return;
      staging.begin_fasta();
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
            if (operationIsCurrent()) {
              post({ type: "status", text: `Reading ${file.name}`, progress, busy: true });
            }
            controller.enqueue(chunk);
          },
        }));
        const compressed = stream as unknown as ReadableStream<BufferSource>;
        stream = compressed.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
      }
      const reader = stream.getReader();
      let fileBytes = 0;
      while (true) {
        const result = await reader.read();
        if (!operationIsCurrent()) {
          await reader.cancel();
          return;
        }
        if (result.done) break;
        staging.push_fasta_chunk(result.value);
        fileBytes += result.value.byteLength;
        if (!compressedFile) {
          const progress = totalBytes > 0
            ? (completedBytes + Math.min(fileBytes, file.size)) / totalBytes
            : 0;
          post({ type: "status", text: `Reading ${file.name}`, progress, busy: true });
        }
      }
      staging.finish_fasta();
      completedBytes += file.size;
    }
    if (!operationIsCurrent()) return;
    const raw = staging.sequences() as Array<{ index: number; name: string; length: number | bigint }>;
    const committed = raw.map((sequence) => ({
      index: sequence.index,
      name: sequence.name,
      length: Number(sequence.length),
    }));
    session.free();
    session = staging;
    loadedSequences = committed;
    post({ type: "sequences", generation, sequences: loadedSequences });
    post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
    return;
  } finally {
    if (session !== staging) staging.free();
  }
}

async function prepareComparison(
  generation: number,
  requestId: number,
  parameters: ComparisonParameters,
): Promise<void> {
  const started = performance.now();
  const domainLength = Math.max(
    loadedSequences.find((sequence) => sequence.index === parameters.xIndex)?.length ?? 0,
    loadedSequences.find((sequence) => sequence.index === parameters.yIndex)?.length ?? 0,
  );
  if (parameters.resolution === domainLength) {
    releaseScientificConfigs();
    session.select_exact_comparison(parameters.xIndex, parameters.yIndex, parameters.k);
    post({
      type: "comparison-ready",
      generation,
      parameters,
      configurations: [],
    });
    const tiles = allTileCoordinates(parameters.resolution, parameters.xIndex === parameters.yIndex);
    await computeExactRequestedTiles(
      generation,
      requestId,
      parameters.resolution,
      tiles,
      parameters,
    );
    if (!isCurrentTileRequest(generation, requestId)) return;
    post({
      type: "complete",
      generation,
      elapsedMs: performance.now() - started,
      estimatedBytes: allocatedWorkerBytes(),
    });
    return;
  }
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
    true,
    firstQuality,
    null,
  );
  if (!firstPrepared) return;
  post({
    type: "comparison-ready",
    generation,
    parameters,
    configurations: [...scientificConfigs.values()].map(configMetadata),
  });
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
    const overviewTiles = allTileCoordinates(
      parameters.resolution,
      parameters.xIndex === parameters.yIndex,
    );
    const detailedTiles = prioritizeForRefinement(
      parameters.resolution,
      overviewTiles,
      "refined",
    );
    if (detailedTiles.length > 0) {
      const detailedPrepared = await prepareOverviewLevel(
        generation,
        requestId,
        parameters,
        parameters.detailedRegisterCount,
        true,
        true,
        "refined",
        detailedTiles,
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
  detailed: boolean,
  progressive: boolean,
  quality: "preview" | "refined",
  progressiveTileFilter: Array<{ x: number; y: number }> | null,
): Promise<boolean> {
  const label = detailed ? "Building high-detail signatures" : "Building quick signatures";
  post({ type: "status", text: label, progress: 0, busy: true });
  const config = requireScientificConfig(registerCount);
  session.begin_prepare_scientific(
    parameters.xIndex,
    parameters.yIndex,
    parameters.resolution,
    config,
    progressive,
  );
  if (progressiveTileFilter) {
    session.set_preparation_tile_filter(
      Uint32Array.from(progressiveTileFilter.flatMap((tile) => [tile.x, tile.y])),
    );
  }
  const token = ++preparationToken;
  let progress = 0;
  const chunkBins = progressive
    ? 256
    : Math.max(16, Math.min(64, Math.ceil(parameters.resolution / 16)));
  while (progress < 1) {
    if (!isCurrentTileRequest(generation, requestId)) {
      if (token === preparationToken) session.cancel_preparation();
      return false;
    }
    progress = session.prepare_comparison_chunk(chunkBins);
    if (progressive) {
      while (true) {
        const tile = session.take_preparation_tile();
        if (!tile) break;
        const x = tile.x;
        const y = tile.y;
        const width = tile.width;
        const height = tile.height;
        const identity = tile.take_identity();
        const direction = tile.take_direction();
        const directionSupport = tile.take_direction_support();
        tile.free();
        publishSketchTile(
          generation,
          parameters.resolution,
          x,
          y,
          width,
          height,
          quality,
          config.digest,
          parameters.xIndex === parameters.yIndex,
          identity,
          direction,
          directionSupport,
        );
      }
    }
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
  const config = requireScientificConfig(registerLimit);
  const tileSize = 256;
  const selfComparison = parameters.xIndex === parameters.yIndex;
  let completed = 0;
  const coordinates = prioritizeForRefinement(
    parameters.resolution,
    allTileCoordinates(parameters.resolution, selfComparison),
    quality,
  );
  const total = Math.max(1, coordinates.length);
  if (coordinates.length === 0) {
    post({
      type: "status",
      text: "Quick overview is already visually settled",
      progress: 1,
      busy: true,
    });
  }
  for (const { x, y } of coordinates) {
      if (!isCurrentTileRequest(generation, requestId)) return;
      const key = `${parameters.resolution}:${x}:${y}:${quality}`;
      if (publishedTiles.has(key)) {
        completed += 1;
        continue;
      }
      const tile = session.compute_tile_scientific(
        x,
        y,
        tileSize,
        tileSize,
        config,
      );
      const identity = tile.take_identity();
      const direction = tile.take_direction();
      const directionSupport = tile.take_direction_support();
      const width = tile.width;
      const height = tile.height;
      tile.free();
      publishSketchTile(
        generation,
        parameters.resolution,
        x,
        y,
        width,
        height,
        quality,
        config.digest,
        selfComparison,
        identity,
        direction,
        directionSupport,
      );
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
    if (!hasDetailedCandidates(resolution, tiles)) {
      post({ type: "status", text: `Ready · ${resolution.toLocaleString()}-cell quick detail is visually settled` });
      post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
      return;
    }
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
        true,
        "refined",
        prioritizeForRefinement(resolution, tiles, "refined"),
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
      const identity = tile.take_identity();
      const direction = tile.take_direction();
      const directionSupport = tile.take_direction_support();
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
          configDigest: `exact-k${parameters.k}`,
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
            configDigest: `exact-k${parameters.k}`,
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
  const config = requireScientificConfig(registerLimit);
  let completed = 0;
  const prioritizedTiles = prioritizeForRefinement(resolution, tiles, quality);
  for (const coordinate of prioritizedTiles) {
    if (!isCurrentTileRequest(generation, requestId)) return;
    const key = `${resolution}:${coordinate.x}:${coordinate.y}:${quality}`;
    if (!publishedTiles.has(key)) {
      const tile = resolution === parametersResolution()
        ? session.compute_tile_scientific(
            coordinate.x,
            coordinate.y,
            256,
            256,
            config,
          )
        : session.compute_zoom_tile_scientific(
            resolution,
            coordinate.x,
            coordinate.y,
            256,
            256,
            config,
          );
      const identity = tile.take_identity();
      const direction = tile.take_direction();
      const directionSupport = tile.take_direction_support();
      const width = tile.width;
      const height = tile.height;
      tile.free();
      publishSketchTile(
        generation,
        resolution,
        coordinate.x,
        coordinate.y,
        width,
        height,
        quality,
        config.digest,
        selfComparison,
        identity,
        direction,
        directionSupport,
      );
    }
    completed += 1;
    post({
      type: "status",
      text: quality === "preview" ? "Drawing quick detail" : "Refining zoom detail",
      progress: completed / Math.max(1, prioritizedTiles.length),
      busy: true,
    });
    await yieldToMessages();
  }
}

function rememberRefinementPriority(
  resolution: number,
  x: number,
  y: number,
  identity: Uint16Array,
  support: Uint16Array,
): void {
  refinementPriority.set(refinementKey(resolution, x, y), tileRefinementPriority(identity, support));
}

function prioritizeForRefinement<T extends { x: number; y: number }>(
  resolution: number,
  tiles: T[],
  quality: "preview" | "refined",
): T[] {
  if (quality === "preview") return tiles;
  return selectRefinementTiles(
    resolution,
    tiles,
    refinementPriority,
    activeParameters?.sparseCorrection ?? false,
  );
}

function hasDetailedCandidates<T extends { x: number; y: number }>(
  resolution: number,
  tiles: T[],
): boolean {
  return selectRefinementTiles(
    resolution,
    tiles,
    refinementPriority,
    activeParameters?.sparseCorrection ?? false,
  ).length > 0;
}

function publishSketchTile(
  generation: number,
  resolution: number,
  x: number,
  y: number,
  width: number,
  height: number,
  quality: "preview" | "refined",
  configDigest: string,
  selfComparison: boolean,
  identity: Uint16Array,
  direction: Int16Array,
  directionSupport: Uint16Array,
): void {
  if (quality === "preview") {
    rememberRefinementPriority(resolution, x, y, identity, directionSupport);
  }
  const mirror = selfComparison && x !== y
    ? transposeTile(identity, direction, directionSupport, width, height)
    : null;
  context.postMessage(
    {
      type: "tile",
      generation,
      configDigest,
      quality,
      resolution,
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
  publishedTiles.add(`${resolution}:${x}:${y}:${quality}`);
  if (mirror) {
    context.postMessage(
      {
        type: "tile",
        generation,
        configDigest,
        quality,
        resolution,
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
    publishedTiles.add(`${resolution}:${y}:${x}:${quality}`);
  }
}

function parametersResolution(): number {
  if (!activeParameters) throw new Error("No active comparison parameters");
  return activeParameters.resolution;
}

function allTileCoordinates(
  resolution: number,
  selfComparison: boolean,
): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < resolution; y += 256) {
    for (let x = selfComparison ? y : 0; x < resolution; x += 256) {
      result.push({ x, y });
    }
  }
  return result;
}

function requireScientificConfig(registerCount: number): ScientificConfig {
  const config = scientificConfigs.get(registerCount);
  if (!config) throw new Error(`No scientific configuration for ${registerCount} registers.`);
  return config;
}

function configMetadata(config: ScientificConfig): ScientificConfigMetadata {
  return {
    version: config.version,
    digest: config.digest,
    hashAlgorithm: config.hash_algorithm,
    hashSeed: config.hash_seed,
    estimator: config.estimator,
    k: config.k,
    registerCount: config.register_count,
    hllPrecision: config.hll_precision,
    bBits: config.b_bits,
    verificationBits: config.verification_bits,
    sparseCoreCap: config.sparse_core_cap,
    aniFloor: config.ani_floor,
    minimumDetectionProbability: config.minimum_detection_probability,
    identityScale: config.identity_scale,
    missingIdentity: config.missing_identity,
  };
}

function releaseScientificConfigs(): void {
  for (const config of scientificConfigs.values()) config.free();
  scientificConfigs.clear();
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
  return operationIsCurrent()
    && generation === activeGeneration
    && requestId === activeTileRequestId;
}

function isCurrentFeatureTrackRequest(generation: number, requestId: number): boolean {
  return operationIsCurrent()
    && generation === activeGeneration
    && requestId === activeFeatureTrackRequestId;
}

function operationIsCurrent(): boolean {
  return executingEpoch === operationEpoch;
}

function yieldToMessages(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function post(message: WorkerToMainMessage): void {
  context.postMessage(message);
}
