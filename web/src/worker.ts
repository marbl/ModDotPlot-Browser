/// <reference lib="webworker" />

import init, { ComputeSession, ScientificConfig } from "./wasm/moddotplot_wasm.js";
import { decompressBgzfStream, isBgzfBlob } from "./bgzf";
import type {
  ComparisonParameters,
  FeatureTrackRequest,
  MainToWorkerMessage,
  RemoteFastaSourceDescriptor,
  ScientificConfigMetadata,
  SequenceMetadata,
  WorkerToMainMessage,
} from "./protocol";
import type {
  PrecomputedOverviewArtifact,
  PrecomputedScientificConfig,
} from "./precomputed-overview";
import { createHttpRangeBlob } from "./http-range-blob";
import { assignSequenceSelectionIds } from "./sequence-metadata";
import {
  associateFastaIndexFiles,
  canUseIndexedFastaInput,
  createIndexedFastaSource,
  parseFai,
  type FaiRecord,
  type FastaInputFiles,
  type IndexedFastaSource,
} from "./indexed-fasta";
import { transposeTile } from "./tile";
import {
  EXACT_KMER_GEOMETRIES,
  exactConfigDigest,
  exactGeometryLabel,
  exactTilePublicationKey,
  type ExactKmerGeometry,
} from "./exact-mode";
import {
  refinementKey,
  summarizeRefinementEvidence,
} from "./refinement";
import { allTileCoordinates, hasDetailedCandidates, prioritizeForRefinement } from "./tile-scheduler";
import {
  ComparisonJob,
  DatasetSession,
  FeatureJob,
  SerializedWorkerQueue,
} from "./worker-jobs";
import {
  ReusableSequenceIngestBuffer,
  SEQUENCE_INGEST_SHARD_BYTES,
  axisShardBins,
} from "./sharding";

const context = self as DedicatedWorkerGlobalScope;
let session: ComputeSession;
let wasmMemory: WebAssembly.Memory;
let datasetJob = new DatasetSession(0);
let comparisonJob: ComparisonJob | null = null;
let featureJob: FeatureJob | null = null;
let indexedSequenceSources = new Map<number, IndexedSequenceRecord>();
let sessionSequenceIndexes = new Map<number, number>();
let globalSequenceIndexes = new Map<number, number>();
let activeSessionParameters: ComparisonParameters | null = null;
let precomputedOverview: PrecomputedOverviewArtifact | null = null;
const scheduler = new SerializedWorkerQueue();
let messageQueue = Promise.resolve();

const MAX_SEQUENCE_BASES = 1_000_000_000;

interface ParsedSequenceRecord {
  index: number;
  name: string;
  description: string;
  length: number | bigint;
}

interface IndexedSequenceRecord {
  source: IndexedFastaSource | null;
  record: FaiRecord;
  remote?: LazyRemoteFastaSource;
}

interface LazyRemoteFastaSource {
  readonly descriptor: RemoteFastaSourceDescriptor;
  readonly fastaIndexText: string;
  source: IndexedFastaSource | null;
  pending: Promise<IndexedFastaSource> | null;
}

interface PlannedFastaInput {
  files: FastaInputFiles;
  indexed: boolean;
}

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
      comparisonJob.cancelTileRequest(message.requestId);
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
  if (message.type === "load" || message.type === "load-precomputed-overview" || message.type === "clear") {
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
    comparisonJob.beginTileRequest(message.requestId);
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
    case "load-precomputed-overview":
      await loadPrecomputedOverview(message.source, message.artifact, message.generation);
      break;
    case "prepare":
      if (!comparisonJob?.canPublish(message.generation, message.requestId)) return;
      initializeComparisonConfigurations(message.parameters);
      if (publishPrecomputedOverview(message.generation, message.requestId, message.parameters)) break;
      {
        const job = comparisonJob;
        await ensureComparisonSequencesLoaded(
          message.parameters,
          () => job.canPublish(message.generation, message.requestId),
          job.tileSignal,
          message.generation,
        );
        if (!job.canPublish(message.generation, message.requestId)) return;
      }
      activeSessionParameters = localComparisonParameters(message.parameters);
      session.retain_prepared_levels(
        message.parameters.previewRegisterCount,
        message.parameters.detailedRegisterCount,
      );
      await prepareComparison(
        message.generation,
        message.requestId,
        requireSessionParameters(),
        message.parameters,
      );
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
      if (publishRequestedPrecomputedTiles(
        message.generation,
        message.requestId,
        message.resolution,
        message.mode,
        message.tiles,
        message.forceDetailed ?? false,
      )) break;
      {
        const job = comparisonJob;
        const needsLazyComparisonSelection = activeSessionParameters === null;
        await ensureComparisonSequencesLoaded(
          job.parameters,
          () => job.canPublish(message.generation, message.requestId),
          job.tileSignal,
          message.generation,
        );
        if (!job.canPublish(message.generation, message.requestId)) return;
        activeSessionParameters = localComparisonParameters(job.parameters);
        if (needsLazyComparisonSelection && precomputedOverview) {
          const active = requireSessionParameters();
          session.select_exact_comparison(active.xIndex, active.yIndex, active.k);
        }
      }
      await computeRequestedTiles(
        message.generation,
        message.requestId,
        message.resolution,
        message.mode,
        message.exactGeometry,
        message.tiles,
        requireSessionParameters(),
        message.forceDetailed ?? false,
      );
      if (message.forceDetailed && isCurrentTileRequest(message.generation, message.requestId)) {
        post({ type: "export-ready", generation: message.generation, requestId: message.requestId });
      }
      break;
    case "clear":
      session.clear();
      indexedSequenceSources.clear();
      sessionSequenceIndexes.clear();
      globalSequenceIndexes.clear();
      activeSessionParameters = null;
      precomputedOverview = null;
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
    const localIndex = await ensureSequenceLoaded(
      sequenceIndex,
      () => isCurrentFeatureTrackRequest(generation, requestId),
      job.signal,
      generation,
    );
    if (!isCurrentFeatureTrackRequest(generation, requestId)) return;
    let ready = session.begin_composition_index(localIndex);
    let progress = ready ? 1 : 0;
    while (!ready) {
      if (!isCurrentFeatureTrackRequest(generation, requestId)) return;
      progress = session.prepare_composition_index_chunk(localIndex, 2_048);
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
          requireLocalSequenceIndex(track.sequenceIndex),
          BigInt(Math.floor(track.start)),
          BigInt(Math.ceil(track.end)),
          track.bins,
        )
      : session.cpg_observed_expected_bins(
          requireLocalSequenceIndex(track.sequenceIndex),
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
  const inputs = associateFastaIndexFiles(files);
  const plannedInputs: PlannedFastaInput[] = [];
  for (const input of inputs) {
    if (!operationIsCurrent()) return;
    plannedInputs.push({ files: input, indexed: await canUseIndexedFastaInput(input) });
  }
  const staging = new ComputeSession();
  const loadedMetadata: Array<Omit<SequenceMetadata, "selectionId">> = [];
  const stagedIndexedSources = new Map<number, IndexedSequenceRecord>();
  const stagedSessionIndexes = new Map<number, number>();
  const stagedGlobalIndexes = new Map<number, number>();
  const totalBytes = plannedInputs.reduce((total, input) => total + (input.indexed
    ? (input.files.fai?.size ?? 0) + (input.files.gzi?.size ?? 0)
    : input.files.fasta.size), 0);
  let completedBytes = 0;
  const ingestBuffer = new ReusableSequenceIngestBuffer(SEQUENCE_INGEST_SHARD_BYTES);
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
      post({ type: "status", generation, text: `Reading and validating ${file.name}`, progress, busy: true });
    }
  };
  try {
    for (const planned of plannedInputs) {
      if (!operationIsCurrent()) return;
      const { fasta, fai, gzi } = planned.files;
      if (planned.indexed && fai) {
        post({
          type: "status",
          generation,
          text: `Reading FASTA index ${fai.name}`,
          progress: totalBytes > 0 ? completedBytes / totalBytes : 0,
          busy: true,
        });
        const faiText = await fai.text();
        const gziBytes = gzi ? await gzi.arrayBuffer() : undefined;
        if (!operationIsCurrent()) return;
        const source = await createIndexedFastaSource(fasta, faiText, { gzi: gziBytes });
        for (const record of source.records) {
          if (record.length > MAX_SEQUENCE_BASES) {
            throw new Error(
              `Sequence '${record.name}' contains ${record.length.toLocaleString()} bases; the limit is ${MAX_SEQUENCE_BASES.toLocaleString()}.`,
            );
          }
          const globalIndex = loadedMetadata.length;
          loadedMetadata.push({
            index: globalIndex,
            name: record.name,
            description: "",
            length: record.length,
            sourceFile: fasta.name,
          });
          stagedIndexedSources.set(globalIndex, { source, record });
        }
        completedBytes += fai.size + (gzi?.size ?? 0);
        continue;
      }

      staging.begin_fasta();
      let stream: ReadableStream<Uint8Array> = fasta.stream();
      const compressedFile = /\.(?:gz|bgz|bgzf)$/i.test(fasta.name);
      if (compressedFile) {
        if (!("DecompressionStream" in globalThis)) {
          throw new Error("This browser cannot decompress gzip FASTA files; use an uncompressed FASTA.");
        }
        let compressedBytes = 0;
        stream = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            compressedBytes += chunk.byteLength;
            reportProgress(fasta, compressedBytes);
            controller.enqueue(chunk);
          },
        }));
        if (await isBgzfBlob(fasta)) {
          stream = decompressBgzfStream(stream);
        } else {
          const compressed = stream as unknown as ReadableStream<BufferSource>;
          stream = compressed.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
        }
      }
      const reader = stream.getReader();
      let fileBytes = 0;
      const appendMetadata = (value: unknown): void => {
        for (const record of parsedSequenceRecords(value)) {
          const globalIndex = loadedMetadata.length;
          loadedMetadata.push({
            index: globalIndex,
            name: record.name,
            description: record.description,
            length: Number(record.length),
            sourceFile: fasta.name,
          });
          stagedSessionIndexes.set(globalIndex, record.index);
          stagedGlobalIndexes.set(record.index, globalIndex);
        }
      };
      const consumeShard = (shard: Uint8Array): void => {
        appendMetadata(staging.push_fasta_chunk(shard));
      };
      while (true) {
        const result = await reader.read();
        if (!operationIsCurrent()) {
          await reader.cancel();
          return;
        }
        if (result.done) break;
        fileBytes += result.value.byteLength;
        if (!compressedFile) reportProgress(fasta, fileBytes);
        ingestBuffer.append(result.value, consumeShard);
      }
      ingestBuffer.flush(consumeShard);
      appendMetadata(staging.finish_fasta());
      completedBytes += fasta.size;
    }
    if (!operationIsCurrent()) return;
    const committed = assignSequenceSelectionIds(loadedMetadata);
    session.free();
    session = staging;
    indexedSequenceSources = stagedIndexedSources;
    sessionSequenceIndexes = stagedSessionIndexes;
    globalSequenceIndexes = stagedGlobalIndexes;
    activeSessionParameters = null;
    precomputedOverview = null;
    datasetJob.sequences = committed;
    post({ type: "sequences", generation, sequences: datasetJob.sequences });
    post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
    return;
  } finally {
    if (session !== staging) staging.free();
  }
}

async function loadPrecomputedOverview(
  sourceDescriptor: RemoteFastaSourceDescriptor,
  artifact: PrecomputedOverviewArtifact,
  generation: number,
): Promise<void> {
  if (!operationIsCurrent()) return;
  const fastaAsset = artifact.sourceAssets.find((asset) => asset.role === "fasta");
  if (!fastaAsset) throw new Error("The bundled overview does not identify its FASTA source.");
  if (
    sourceDescriptor.fileName !== fastaAsset.fileName
    || sourceDescriptor.byteLength !== fastaAsset.byteLength
  ) {
    throw new Error("The bundled overview and remote FASTA descriptor do not match.");
  }
  if (!Number.isSafeInteger(sourceDescriptor.byteLength) || sourceDescriptor.byteLength <= 0) {
    throw new Error("The bundled overview declares an invalid remote FASTA size.");
  }
  const remoteUrl = new URL(sourceDescriptor.url, context.location.href);
  if (remoteUrl.origin !== context.location.origin) {
    throw new Error("The bundled overview FASTA must be served from this application's origin.");
  }

  const records = parseFai(artifact.fastaIndexText);
  if (records.length !== artifact.sequences.length) {
    throw new Error("The bundled overview sequence metadata does not match its FASTA index.");
  }
  const lazyRemote: LazyRemoteFastaSource = {
    descriptor: Object.freeze({
      ...sourceDescriptor,
      url: remoteUrl.href,
    }),
    fastaIndexText: artifact.fastaIndexText,
    source: null,
    pending: null,
  };
  const stagedIndexedSources = new Map<number, IndexedSequenceRecord>();
  const metadata: Array<Omit<SequenceMetadata, "selectionId">> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const sequence = artifact.sequences[index];
    if (!record || !sequence || sequence.index !== index) {
      throw new Error("The bundled overview sequence order is invalid.");
    }
    if (
      record.name !== sequence.name
      || record.length !== sequence.length
      || sequence.sourceFile !== sourceDescriptor.fileName
    ) {
      throw new Error("The bundled overview sequence metadata disagrees with its FASTA index.");
    }
    if (record.length > MAX_SEQUENCE_BASES) {
      throw new Error(
        `Sequence '${record.name}' contains ${record.length.toLocaleString()} bases; the limit is ${MAX_SEQUENCE_BASES.toLocaleString()}.`,
      );
    }
    metadata.push({
      index,
      name: sequence.name,
      description: sequence.description,
      length: sequence.length,
      sourceFile: sequence.sourceFile,
    });
    stagedIndexedSources.set(index, { source: null, record, remote: lazyRemote });
  }
  if (!operationIsCurrent()) return;

  const staging = new ComputeSession();
  session.free();
  session = staging;
  indexedSequenceSources = stagedIndexedSources;
  sessionSequenceIndexes = new Map();
  globalSequenceIndexes = new Map();
  activeSessionParameters = null;
  precomputedOverview = artifact;
  datasetJob.sequences = assignSequenceSelectionIds(metadata);
  post({ type: "sequences", generation, sequences: datasetJob.sequences });
  post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
}

function parsedSequenceRecords(value: unknown): ParsedSequenceRecord[] {
  return value as ParsedSequenceRecord[];
}

async function ensureComparisonSequencesLoaded(
  parameters: Readonly<ComparisonParameters>,
  isCurrent: () => boolean,
  signal: AbortSignal,
  generation: number,
): Promise<void> {
  await ensureSequenceLoaded(parameters.xIndex, isCurrent, signal, generation);
  if (parameters.yIndex !== parameters.xIndex && isCurrent()) {
    await ensureSequenceLoaded(parameters.yIndex, isCurrent, signal, generation);
  }
}

async function ensureSequenceLoaded(
  globalIndex: number,
  isCurrent: () => boolean,
  signal: AbortSignal,
  generation: number,
): Promise<number> {
  const resident = sessionSequenceIndexes.get(globalIndex);
  if (resident !== undefined) return resident;
  const indexed = indexedSequenceSources.get(globalIndex);
  if (!indexed) throw new Error("A selected sequence is no longer available in this dataset.");
  if (!isCurrent() || signal.aborted) throw indexedReadAbortError();
  const indexedSource = await resolveIndexedSource(indexed, isCurrent, signal);
  if (!isCurrent() || signal.aborted) throw indexedReadAbortError();

  const ingestBuffer = new ReusableSequenceIngestBuffer(SEQUENCE_INGEST_SHARD_BYTES);
  const completed: ParsedSequenceRecord[] = [];
  let fastaActive = false;
  let loadedBases = 0;
  const appendMetadata = (value: unknown): void => {
    completed.push(...parsedSequenceRecords(value));
  };
  const consumeShard = (shard: Uint8Array): void => {
    appendMetadata(session.push_fasta_chunk(shard));
  };

  try {
    const recordStream = await indexedSource.streamFastaRecord(indexed.record.name, { signal });
    if (!isCurrent() || signal.aborted) throw indexedReadAbortError();
    session.begin_fasta();
    fastaActive = true;
    const reader = recordStream.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!isCurrent() || signal.aborted) {
          await reader.cancel(indexedReadAbortError());
          throw indexedReadAbortError();
        }
        loadedBases += result.value.byteLength;
        ingestBuffer.append(result.value, consumeShard);
        post({
          type: "status",
          generation,
          text: `Loading indexed sequence · ${indexed.record.name}`,
          progress: Math.min(1, loadedBases / indexed.record.length),
          busy: true,
        });
      }
    } finally {
      reader.releaseLock();
    }
    if (!isCurrent() || signal.aborted) {
      abortActiveFasta(session);
      fastaActive = false;
      throw indexedReadAbortError();
    }
    ingestBuffer.flush(consumeShard);
    appendMetadata(session.finish_indexed_fasta(
      indexed.record.name,
      BigInt(indexed.record.length),
    ));
    fastaActive = false;
  } catch (error: unknown) {
    if (fastaActive) abortActiveFasta(session);
    throw error;
  }

  // Rust commits the indexed load transaction only after validating that it yielded
  // exactly this one FAI name and length. Keep this browser-side assertion as a
  // defense against stale generated bindings or an unexpected metadata contract.
  if (completed.length !== 1) {
    throw new Error(
      `Indexed FASTA record '${indexed.record.name}' produced ${completed.length} parsed records instead of one.`,
    );
  }
  const record = completed[0];
  if (!record || record.name !== indexed.record.name || Number(record.length) !== indexed.record.length) {
    throw new Error(`Indexed FASTA record '${indexed.record.name}' does not match its FAI metadata.`);
  }
  sessionSequenceIndexes.set(globalIndex, record.index);
  globalSequenceIndexes.set(record.index, globalIndex);
  post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
  return record.index;
}

async function resolveIndexedSource(
  indexed: IndexedSequenceRecord,
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<IndexedFastaSource> {
  if (indexed.source) return indexed.source;
  const remote = indexed.remote;
  if (!remote) throw new Error("The indexed FASTA source is unavailable.");
  if (remote.source) {
    indexed.source = remote.source;
    return remote.source;
  }
  if (!isCurrent() || signal.aborted) throw indexedReadAbortError();
  if (!remote.pending) {
    remote.pending = (async () => {
      const file = await createHttpRangeBlob(remote.descriptor.url, {
        signal,
        mediaType: "text/plain",
      });
      if (file.size !== remote.descriptor.byteLength) {
        throw new Error(
          `Remote FASTA size changed from ${remote.descriptor.byteLength.toLocaleString()} to ${file.size.toLocaleString()} bytes.`,
        );
      }
      const source = await createIndexedFastaSource(file, remote.fastaIndexText);
      if (source.records.length !== artifactSequenceCount()) {
        throw new Error("Remote FASTA index no longer matches the bundled overview.");
      }
      remote.source = source;
      return source;
    })().catch((error: unknown) => {
      remote.pending = null;
      throw error;
    });
  }
  const source = await remote.pending;
  indexed.source = source;
  return source;
}

function artifactSequenceCount(): number {
  return precomputedOverview?.sequences.length ?? datasetJob.sequences.length;
}

function abortActiveFasta(target: ComputeSession): void {
  const abort = (target as ComputeSession & { abort_fasta?: () => void }).abort_fasta;
  if (typeof abort === "function") {
    abort.call(target);
    return;
  }
  throw new Error("This compute-engine build cannot safely cancel indexed FASTA loading; rebuild the Wasm bindings.");
}

function indexedReadAbortError(): DOMException {
  return new DOMException("Indexed FASTA loading was cancelled.", "AbortError");
}

function requireLocalSequenceIndex(globalIndex: number): number {
  const localIndex = sessionSequenceIndexes.get(globalIndex);
  if (localIndex === undefined) throw new Error("A selected sequence has not been loaded into the compute session.");
  return localIndex;
}

function localComparisonParameters(parameters: Readonly<ComparisonParameters>): ComparisonParameters {
  return {
    ...parameters,
    xIndex: requireLocalSequenceIndex(parameters.xIndex),
    yIndex: requireLocalSequenceIndex(parameters.yIndex),
  };
}

function requireSessionParameters(): ComparisonParameters {
  if (!activeSessionParameters) throw new Error("No compute-session comparison is active.");
  return activeSessionParameters;
}

async function prepareComparison(
  generation: number,
  requestId: number,
  parameters: ComparisonParameters,
  publishedParameters: ComparisonParameters,
): Promise<void> {
  const started = performance.now();
  const domainLength = Math.max(
    datasetJob.sequences.find((sequence) => sequence.index === publishedParameters.xIndex)?.length ?? 0,
    datasetJob.sequences.find((sequence) => sequence.index === publishedParameters.yIndex)?.length ?? 0,
  );
  if (parameters.resolution === domainLength) {
    releaseScientificConfigurations(requireComparisonJob());
    session.select_exact_comparison(parameters.xIndex, parameters.yIndex, parameters.k);
    post({
      type: "comparison-ready",
      generation,
      parameters: publishedParameters,
      configurations: [],
    });
    const tiles = allTileCoordinates(parameters.resolution, parameters.xIndex === parameters.yIndex);
    await computeExactRequestedTiles(
      generation,
      requestId,
      parameters.resolution,
      tiles,
      parameters,
      parameters.exactGeometry,
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
    parameters: publishedParameters,
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
      requireComparisonJob(),
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
  post({ type: "status", generation, text: label, progress: 0, busy: true });
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
    post({ type: "status", generation, text: label, progress, busy: true });
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
    requireComparisonJob(),
  );
  const total = Math.max(1, coordinates.length);
  if (coordinates.length === 0) {
    post({
      type: "status",
      generation,
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
        generation,
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
  exactGeometry: ExactKmerGeometry,
  tiles: Array<{ x: number; y: number }>,
  parameters: ComparisonParameters,
  forceDetailed = false,
): Promise<void> {
  if (tiles.length === 0) return;
  if (mode === "kmer") {
    await computeExactRequestedTiles(
      generation,
      requestId,
      resolution,
      tiles,
      parameters,
      exactGeometry,
    );
    return;
  }
  if (forceDetailed) {
    const registerCount = parameters.detailedRegisterCount;
    if (resolution === parameters.resolution && !session.has_prepared_level(registerCount)) {
      const prepared = await prepareOverviewLevel(
        generation,
        requestId,
        parameters,
        registerCount,
        true,
        true,
        "refined",
        tiles,
      );
      if (!prepared) return;
    }
    await computeRequestedLevel(
      generation,
      requestId,
      resolution,
      tiles,
      registerCount,
      "refined",
      parameters.xIndex === parameters.yIndex,
      true,
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
    if (!hasDetailedCandidates(resolution, tiles, requireComparisonJob())) {
      post({ type: "status", generation, text: `Ready · ${resolution.toLocaleString()}-cell quick detail is visually settled` });
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
        prioritizeForRefinement(resolution, tiles, "refined", requireComparisonJob()),
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
    post({ type: "status", generation, text: `Ready · ${resolution.toLocaleString()}-cell detail cached` });
    post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
  }
}

async function computeExactRequestedTiles(
  generation: number,
  requestId: number,
  resolution: number,
  tiles: Array<{ x: number; y: number }>,
  parameters: ComparisonParameters,
  geometry: ExactKmerGeometry,
): Promise<void> {
  const selfComparison = parameters.xIndex === parameters.yIndex;
  let completed = 0;
  for (const coordinate of tiles) {
    if (!isCurrentTileRequest(generation, requestId)) return;
    const key = exactTilePublicationKey(resolution, coordinate.x, coordinate.y, geometry);
    if (!requireComparisonJob().publishedTiles.has(key)) {
      const tile = session.compute_kmer_tile(
        BigInt(coordinate.x),
        BigInt(coordinate.y),
        256,
        256,
        geometry === "anchors",
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
          configDigest: exactConfigDigest(parameters.k, geometry),
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
            configDigest: exactConfigDigest(parameters.k, geometry),
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
        requireComparisonJob().publishedTiles.add(
          exactTilePublicationKey(resolution, coordinate.y, coordinate.x, geometry),
        );
      }
    }
    completed += 1;
    post({
      type: "status",
      generation,
      text: `Drawing exact k-mers · ${exactGeometryLabel(geometry).toLowerCase()}`,
      progress: completed / tiles.length,
      busy: true,
    });
    await yieldToMessages();
  }
  if (isCurrentTileRequest(generation, requestId)) {
    post({
      type: "status",
      generation,
      text: `Ready · exact ${exactGeometryLabel(geometry).toLowerCase()} cached`,
    });
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
  forceAll = false,
): Promise<void> {
  const config = requireScientificConfig(registerLimit);
  let completed = 0;
  const prioritizedTiles = forceAll
    ? tiles
    : prioritizeForRefinement(
        resolution,
        tiles,
        quality,
        requireComparisonJob(),
      );
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
      generation,
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

function initializeComparisonConfigurations(parameters: Readonly<ComparisonParameters>): void {
  const job = requireComparisonJob();
  releaseScientificConfigurations(job);
  if (parameters.previewRegisterCount < parameters.detailedRegisterCount) {
    job.configurations.set(
      parameters.previewRegisterCount,
      new ScientificConfig(parameters.k, parameters.previewRegisterCount),
    );
  }
  job.configurations.set(
    parameters.detailedRegisterCount,
    new ScientificConfig(parameters.k, parameters.detailedRegisterCount),
  );
}

function publishPrecomputedOverview(
  generation: number,
  requestId: number,
  parameters: Readonly<ComparisonParameters>,
): boolean {
  const artifact = matchingPrecomputedOverview(parameters);
  if (!artifact || !isCurrentTileRequest(generation, requestId)) return false;
  const started = performance.now();
  activeSessionParameters = null;
  post({
    type: "comparison-ready",
    generation,
    parameters: { ...parameters },
    configurations: [...requireComparisonJob().configurations.values()].map(configMetadata),
  });
  for (const tile of artifact.tiles) publishPrecomputedTile(generation, tile);
  post({
    type: "complete",
    generation,
    elapsedMs: performance.now() - started,
    estimatedBytes: allocatedWorkerBytes(),
    precomputed: true,
  });
  return true;
}

function publishRequestedPrecomputedTiles(
  generation: number,
  requestId: number,
  resolution: number,
  mode: "sketch" | "kmer",
  coordinates: Array<{ x: number; y: number }>,
  forceDetailed: boolean,
): boolean {
  if (mode !== "sketch" || coordinates.length === 0) return false;
  const artifact = matchingPrecomputedOverview(requireComparisonJob().parameters);
  if (!artifact || resolution !== artifact.comparison.resolution) return false;
  const tilesByOrigin = new Map(artifact.tiles.map((tile) => [`${tile.x}:${tile.y}`, tile]));
  const selected = coordinates.map(({ x, y }) => tilesByOrigin.get(`${x}:${y}`));
  if (selected.some((tile) => tile === undefined)) return false;
  for (const tile of selected) publishPrecomputedTile(generation, tile!);
  post({ type: "status", generation, text: "Ready · bundled overview cached" });
  post({ type: "memory", estimatedBytes: allocatedWorkerBytes() });
  if (forceDetailed && isCurrentTileRequest(generation, requestId)) {
    post({ type: "export-ready", generation, requestId });
  }
  return true;
}

function matchingPrecomputedOverview(
  parameters: Readonly<ComparisonParameters>,
): PrecomputedOverviewArtifact | null {
  const artifact = precomputedOverview;
  if (!artifact) return null;
  const comparison = artifact.comparison;
  if (
    parameters.xIndex !== comparison.xIndex
    || parameters.yIndex !== comparison.yIndex
    || parameters.resolution !== comparison.resolution
    || parameters.k !== comparison.k
  ) return null;
  const runtime = requireComparisonJob().configurations.get(parameters.detailedRegisterCount);
  const cached = artifact.configurations.find((config) => config.digest === comparison.configDigest);
  if (!runtime || !cached || !scientificConfigMatches(configMetadata(runtime), cached)) return null;
  return artifact;
}

function scientificConfigMatches(
  runtime: ScientificConfigMetadata,
  cached: PrecomputedScientificConfig,
): boolean {
  return runtime.version === cached.version
    && runtime.identity === cached.identity
    && runtime.digest === cached.digest
    && runtime.hashAlgorithm === cached.hashAlgorithm
    && runtime.hashSeed === cached.hashSeed
    && runtime.estimator === cached.estimator
    && runtime.k === cached.k
    && runtime.registerCount === cached.registerCount
    && runtime.hllPrecision === cached.hllPrecision
    && runtime.bBits === cached.bBits
    && runtime.verificationBits === cached.verificationBits
    && runtime.identityScale === cached.identityScale
    && runtime.missingIdentity === cached.missingIdentity;
}

function publishPrecomputedTile(
  generation: number,
  tile: PrecomputedOverviewArtifact["tiles"][number],
): void {
  const identity = tile.identity.slice();
  const direction = tile.direction.slice();
  const directionSupport = tile.directionSupport.slice();
  context.postMessage(
    {
      type: "tile",
      generation,
      configDigest: tile.configDigest,
      quality: tile.quality,
      resolution: tile.resolution,
      x: tile.x,
      y: tile.y,
      width: tile.width,
      height: tile.height,
      identity,
      direction,
      directionSupport,
    },
    [identity.buffer, direction.buffer, directionSupport.buffer],
  );
  requireComparisonJob().publishedTiles.add(
    `${tile.resolution}:${tile.x}:${tile.y}:${tile.quality}`,
  );
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
    identity: config.identity,
    hashAlgorithm: config.hash_algorithm,
    hashSeed: config.hash_seed,
    estimator: config.estimator,
    k: config.k,
    registerCount: config.register_count,
    hllPrecision: config.hll_precision,
    bBits: config.b_bits,
    verificationBits: config.verification_bits,
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
  const globalIndex = globalSequenceIndexes.get(sequenceIndex);
  const metadata = globalIndex === undefined
    ? undefined
    : datasetJob.sequences.find((sequence) => sequence.index === globalIndex);
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
  for (const quality of ["preview", "refined"] as const) {
    comparisonJob?.publishedTiles.delete(`${resolution}:${x}:${y}:${quality}`);
  }
  for (const geometry of EXACT_KMER_GEOMETRIES) {
    comparisonJob?.publishedTiles.delete(exactTilePublicationKey(resolution, x, y, geometry));
  }
}

function allocatedWorkerBytes(): number {
  const cachedOverviewBytes = precomputedOverview?.tiles.reduce(
    (total, tile) => total
      + tile.identity.byteLength
      + tile.direction.byteLength
      + tile.directionSupport.byteLength,
    0,
  ) ?? 0;
  return Math.max(session.estimated_memory_bytes(), wasmMemory.buffer.byteLength)
    + cachedOverviewBytes;
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
