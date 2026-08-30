/// <reference lib="webworker" />

import init, { ComputeSession, ScientificConfig } from "./wasm/moddotplot_wasm.js";
import { decompressBgzfStream, isBgzfBlob } from "./bgzf";
import type {
  ComparisonParameters,
  FeatureTrackRequest,
  MainToWorkerMessage,
  ScientificConfigMetadata,
  WorkerToMainMessage,
} from "./protocol";
import { transposeTile } from "./tile";
import {
  refinementKey,
  selectRefinementTiles,
  summarizeRefinementEvidence,
} from "./refinement";
import {
  ComparisonJob,
  DatasetSession,
  FeatureJob,
  SerializedWorkerQueue,
} from "./worker-jobs";
import {
  SEQUENCE_INGEST_SHARD_BYTES,
  axisShardBins,
  sequenceShardRanges,
} from "./sharding";

const context = self as DedicatedWorkerGlobalScope;
let session: ComputeSession;
let wasmMemory: WebAssembly.Memory;
let datasetJob = new DatasetSession(0);
let comparisonJob: ComparisonJob | null = null;
let featureJob: FeatureJob | null = null;
const scheduler = new SerializedWorkerQueue();
let messageQueue = Promise.resolve();

const engineReady = init().then((wasm) => {
  wasmMemory = wasm.memory;
  session = new ComputeSession();
  post({ type: "ready" });
});

context.onmessage = (event: MessageEvent<MainToWorkerMessage>): void => {
  const message = event.data;
  if (message.type === "preview-presented") {
    if (comparisonJob?.canPublish(message.generation, message.requestId)) {
      comparisonJob.releasePresentation();
    }
    return;
  }
  if (message.type === "update-refinement-policy") {
    if (message.generation === comparisonJob?.generation) {
      comparisonJob.refinementDisplayMinimum = message.displayMinimum;
    }
    return;
  }
  if (message.type === "cancel-tiles") {
    scheduler.invalidate();
    if (message.generation === comparisonJob?.generation) {
      comparisonJob.activeTileRequestId = message.requestId;
      comparisonJob.releasePresentation();
    }
    return;
  }
  if (message.type === "evict-tiles") {
    if (message.generation === comparisonJob?.generation) {
      for (const tile of message.tiles) forgetPublishedTile(tile.resolution, tile.x, tile.y);
    }
    return;
  }
  if (message.type === "cancel-feature-tracks") {
    if (message.generation === comparisonJob?.generation) {
      featureJob?.cancel("feature tracks cancelled");
      featureJob = new FeatureJob(message.generation, message.requestId);
      featureJob.cancel("cancellation marker");
    }
    return;
  }
  if (message.type === "request-feature-tracks") {
    featureJob?.cancel("superseded feature request");
    const job = new FeatureJob(message.generation, message.requestId);
    featureJob = job;
    messageQueue = messageQueue.then(async () => {
      if (job.signal.aborted || featureJob !== job) return;
      await engineReady;
      await computeFeatureTracks(job, message.tracks);
    }).catch((error: unknown) => {
      if (job.signal.aborted || featureJob !== job) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      post({ type: "error", message: errorMessage });
    });
    return;
  }
  if (message.type === "load" || message.type === "clear") {
    datasetJob.cancel("dataset replaced");
    comparisonJob?.cancel("dataset replaced");
    comparisonJob = null;
    featureJob?.cancel("dataset replaced");
    featureJob = null;
    datasetJob = new DatasetSession(message.generation);
  } else if (message.type === "prepare") {
    comparisonJob?.cancel("comparison replaced");
    comparisonJob = new ComparisonJob(message.generation, message.requestId, message.parameters);
    featureJob?.cancel("comparison replaced");
    featureJob = null;
  } else if (message.type === "request-tiles" && comparisonJob) {
    comparisonJob.activeTileRequestId = message.requestId;
    comparisonJob.releasePresentation();
  }
  const ticket = scheduler.invalidate();
  messageQueue = messageQueue.then(async () => {
    scheduler.begin(ticket);
    await handleMessage(message);
  }).catch((error: unknown) => {
    if (ticket !== scheduler.ticket()) return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    post({ type: "error", message: errorMessage });
  });
};

async function handleMessage(message: MainToWorkerMessage): Promise<void> {
  await engineReady;
  switch (message.type) {
    case "load":
      await loadFiles(message.files, message.generation);
      break;
    case "prepare":
      if (!comparisonJob?.canPublish(message.generation, message.requestId)) return;
      if (message.parameters.previewRegisterCount < message.parameters.detailedRegisterCount) {
        comparisonJob.configurations.set(
          message.parameters.previewRegisterCount,
          new ScientificConfig(message.parameters.k, message.parameters.previewRegisterCount, false),
        );
      }
      comparisonJob.configurations.set(
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
    case "update-refinement-policy":
    case "evict-tiles":
    case "cancel-feature-tracks":
    case "request-feature-tracks":
      break;
    case "request-tiles":
      if (!comparisonJob?.canPublish(message.generation, message.requestId)) return;
      await computeRequestedTiles(
        message.generation,
        message.requestId,
        message.resolution,
        message.mode,
        message.tiles,
        comparisonJob.parameters,
      );
      break;
    case "clear":
      session.clear();
      break;
  }
}

async function computeFeatureTracks(
  job: FeatureJob,
  tracks: FeatureTrackRequest[],
): Promise<void> {
  const { generation, requestId } = job;
  if (!isCurrentFeatureTrackRequest(generation, requestId) || tracks.length === 0) return;
  const sequenceIndexes = [...new Set(tracks.map((track) => track.sequenceIndex))];
  const totalBases = Math.max(1, sequenceIndexes.reduce((total, sequenceIndex) =>
    total + (datasetJob.sequences.find((sequence) => sequence.index === sequenceIndex)?.length ?? 0), 0));
  let completedBases = 0;

  for (const sequenceIndex of sequenceIndexes) {
    if (!isCurrentFeatureTrackRequest(generation, requestId)) return;
    const metadata = datasetJob.sequences.find((sequence) => sequence.index === sequenceIndex);
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
  let lastProgressFile = "";
  let lastProgressPercentage = -1;
  const reportProgress = (file: File, currentBytes: number): void => {
    const progress = totalBytes > 0
      ? (completedBytes + Math.min(currentBytes, file.size)) / totalBytes
      : 0;
    const percentage = Math.floor(progress * 100);
    if (file.name === lastProgressFile && percentage === lastProgressPercentage) return;
    lastProgressFile = file.name;
    lastProgressPercentage = percentage;
    if (operationIsCurrent()) {
      post({ type: "status", text: `Reading ${file.name}`, progress, busy: true });
    }
  };
  try {
    for (const file of files) {
      if (!operationIsCurrent()) return;
      staging.begin_fasta();
      let stream: ReadableStream<Uint8Array> = file.stream();
      const compressedFile = /\.(?:gz|bgz|bgzf)$/i.test(file.name);
      if (compressedFile) {
        if (!("DecompressionStream" in globalThis)) {
          throw new Error("This browser cannot decompress gzip FASTA files; use an uncompressed FASTA.");
        }
        let compressedBytes = 0;
        stream = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            compressedBytes += chunk.byteLength;
            reportProgress(file, compressedBytes);
            controller.enqueue(chunk);
          },
        }));
        if (await isBgzfBlob(file)) {
          stream = decompressBgzfStream(stream);
        } else {
          const compressed = stream as unknown as ReadableStream<BufferSource>;
          stream = compressed.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
        }
      }
      const reader = stream.getReader();
      let fileBytes = 0;
      let batchBytes = 0;
      let batchChunks: Uint8Array[] = [];
      const flushBatch = (): void => {
        if (batchBytes === 0) return;
        if (batchChunks.length === 1) {
          staging.push_fasta_chunk(batchChunks[0] ?? new Uint8Array());
        } else {
          const batch = new Uint8Array(batchBytes);
          let offset = 0;
          for (const chunk of batchChunks) {
            batch.set(chunk, offset);
            offset += chunk.byteLength;
          }
          staging.push_fasta_chunk(batch);
        }
        batchBytes = 0;
        batchChunks = [];
      };
      while (true) {
        const result = await reader.read();
        if (!operationIsCurrent()) {
          await reader.cancel();
          return;
        }
        if (result.done) break;
        fileBytes += result.value.byteLength;
        if (!compressedFile) {
          reportProgress(file, fileBytes);
        }
        if (batchBytes + result.value.byteLength <= SEQUENCE_INGEST_SHARD_BYTES) {
          batchChunks.push(result.value);
          batchBytes += result.value.byteLength;
          if (batchBytes >= SEQUENCE_INGEST_SHARD_BYTES) flushBatch();
        } else {
          flushBatch();
          for (const range of sequenceShardRanges(result.value.byteLength)) {
            const shard = result.value.subarray(range.start, range.end);
            if (shard.byteLength === SEQUENCE_INGEST_SHARD_BYTES) {
              staging.push_fasta_chunk(shard);
            } else {
              batchChunks.push(shard);
              batchBytes += shard.byteLength;
            }
          }
        }
      }
      flushBatch();
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
    datasetJob.sequences = committed;
    post({ type: "sequences", generation, sequences: datasetJob.sequences });
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
    datasetJob.sequences.find((sequence) => sequence.index === parameters.xIndex)?.length ?? 0,
    datasetJob.sequences.find((sequence) => sequence.index === parameters.yIndex)?.length ?? 0,
  );
  if (parameters.resolution === domainLength) {
    releaseScientificConfigurations(requireComparisonJob());
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
    configurations: [...requireComparisonJob().configurations.values()].map(configMetadata),
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
  const job = requireComparisonJob();
  const token = ++job.preparationToken;
  let progress = 0;
  const chunkBins = axisShardBins(parameters.resolution, progressive);
  while (progress < 1) {
    if (!isCurrentTileRequest(generation, requestId)) {
      if (token === job.preparationToken) session.cancel_preparation();
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
      if (requireComparisonJob().publishedTiles.has(key)) {
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
    if (!requireComparisonJob().publishedTiles.has(key)) {
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
      requireComparisonJob().publishedTiles.add(key);
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
        requireComparisonJob().publishedTiles.add(`${resolution}:${coordinate.y}:${coordinate.x}:exact`);
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
    if (!requireComparisonJob().publishedTiles.has(key)) {
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
  const job = requireComparisonJob();
  job.refinementEvidence.set(
    refinementKey(resolution, x, y),
    summarizeRefinementEvidence(identity, support),
  );
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
    requireComparisonJob().refinementEvidence,
    {
      displayMinimum: requireComparisonJob().refinementDisplayMinimum,
      refineAll: requireComparisonJob().parameters.sparseCorrection,
    },
  );
}

function hasDetailedCandidates<T extends { x: number; y: number }>(
  resolution: number,
  tiles: T[],
): boolean {
  return selectRefinementTiles(
    resolution,
    tiles,
    requireComparisonJob().refinementEvidence,
    {
      displayMinimum: requireComparisonJob().refinementDisplayMinimum,
      refineAll: requireComparisonJob().parameters.sparseCorrection,
    },
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
  requireComparisonJob().publishedTiles.add(`${resolution}:${x}:${y}:${quality}`);
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
    requireComparisonJob().publishedTiles.add(`${resolution}:${y}:${x}:${quality}`);
  }
}

function parametersResolution(): number {
  return requireComparisonJob().parameters.resolution;
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
  const config = requireComparisonJob().configurations.get(registerCount);
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

function releaseScientificConfigurations(job: ComparisonJob): void {
  for (const config of job.configurations.values()) config.free();
  job.configurations.clear();
}

function readBaseCodes(sequenceIndex: number, start: number, count: number): Uint8Array {
  const result = new Uint8Array(count);
  result.fill(4);
  const metadata = datasetJob.sequences.find((sequence) => sequence.index === sequenceIndex);
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
  const job = requireComparisonJob();
  job.releasePresentation();
  return new Promise((resolve) => {
    job.pendingPresentation = { resolve };
    post({ type: "preview-complete", generation, requestId });
  });
}

function forgetPublishedTile(resolution: number, x: number, y: number): void {
  for (const quality of ["preview", "refined", "exact"] as const) {
    comparisonJob?.publishedTiles.delete(`${resolution}:${x}:${y}:${quality}`);
  }
}

function allocatedWorkerBytes(): number {
  return Math.max(session.estimated_memory_bytes(), wasmMemory.buffer.byteLength);
}

function isCurrentTileRequest(generation: number, requestId: number): boolean {
  return operationIsCurrent() && comparisonJob?.canPublish(generation, requestId) === true;
}

function isCurrentFeatureTrackRequest(generation: number, requestId: number): boolean {
  return datasetJob.canServe()
    && featureJob?.canPublish(generation, requestId) === true;
}

function operationIsCurrent(): boolean {
  return scheduler.isCurrent() && !datasetJob.signal.aborted;
}

function requireComparisonJob(): ComparisonJob {
  if (!comparisonJob || comparisonJob.signal.aborted) {
    throw new Error("No active comparison job");
  }
  return comparisonJob;
}

function yieldToMessages(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function post(message: WorkerToMainMessage): void {
  context.postMessage(message);
}
