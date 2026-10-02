/// <reference lib="webworker" />

import { decompressBgzfStream, isBgzfBlob } from "./bgzf";
import {
  annotationAdmissionError,
  assignFeatureLanes,
  gffFeatureColor,
  inferFeatureFormat,
  parseItemRgb,
  resolveTrackSequenceIdentifier,
  sequenceIdentifierMatch,
  type ImportIssue,
  type ImportedFeature,
  type ImportedLogicalTrack,
  type ImportedTrackFormat,
  type TrackImportReport,
  type TrackParserMessage,
  type TrackParserRequest,
  type TrackSequenceCandidate,
} from "./imported-track-types";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const DEFAULT_COLOR = "#171717";
const OTHER_GENE_COLOR = "#45464a";
const MAX_REPORTED_ISSUES = 24;
const parserJobs = new Map<number, AbortController>();

interface ParseState {
  fileName: string;
  format: ImportedTrackFormat | null;
  target: { index: number; name: string; length: number };
  lineNumber: number;
  validRecords: number;
  skippedRecords: number;
  clippedRecords: number;
  ignoredSequenceRecords: number;
  identifiers: Set<string>;
  issues: ImportIssue[];
  exactSeen: boolean;
  bedTrackName: string;
  bedTracks: Map<string, ImportedFeature[]>;
  transcripts: Map<string, TranscriptBuilder>;
  genes: Map<string, GeneRecord>;
  otherGff: ImportedFeature[];
  admission: RecordAdmission;
}

interface RecordAdmission {
  records: number;
}

interface TranscriptBuilder {
  id: string;
  name: string;
  type: string;
  start: number;
  end: number;
  strand: "+" | "-" | ".";
  parentGene: string;
  blocks: number[];
  cdsStart?: number;
  cdsEnd?: number;
  details: string[];
  color: string;
}

interface GeneRecord {
  id: string;
  name: string;
  start: number;
  end: number;
  strand: "+" | "-" | ".";
  hasTranscript: boolean;
  details: string[];
  color: string;
}

workerScope.onmessage = (event: MessageEvent<TrackParserRequest>): void => {
  const request = event.data;
  if (request.type === "cancel") {
    for (const requestId of request.requestIds) {
      parserJobs.get(requestId)?.abort("annotation import cancelled");
      parserJobs.delete(requestId);
    }
    return;
  }
  const controller = new AbortController();
  parserJobs.set(request.requestId, controller);
  const admissionError = annotationAdmissionError(request.file.size, 0);
  const operation = admissionError
    ? Promise.reject(new Error(admissionError))
    : request.type === "parse"
      ? parseFile(request, controller.signal)
      : request.type === "parse-batch"
        ? parseBatchFile(request, controller.signal)
        : inspectFile(request, controller.signal);
  void operation.catch((error: unknown) => {
    if (controller.signal.aborted) return;
    post({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
      issues: [],
    });
  }).finally(() => parserJobs.delete(request.requestId));
};

async function inspectFile(
  request: Extract<TrackParserRequest, { type: "inspect" }>,
  signal: AbortSignal,
): Promise<void> {
  const identifiers = new Set<string>();
  await readLines(request.file, signal, (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("track ") || trimmed.startsWith("browser ")) return;
    const identifier = line.split("\t", 1)[0]?.trim();
    if (identifier) identifiers.add(identifier);
  }, (progress) => {
    post({ type: "progress", requestId: request.requestId, progress, text: `Matching ${request.file.name}` });
  });
  if (signal.aborted) return;
  const matches: Array<TrackSequenceCandidate & { identifier: string; matchKind: "exact" | "alias" }> = [];
  for (const candidate of request.candidates) {
    let best: { identifier: string; matchKind: "exact" | "alias" } | null = null;
    for (const identifier of identifiers) {
      const matchKind = sequenceIdentifierMatch(identifier, candidate.name);
      if (!matchKind) continue;
      if (!best || matchKind === "exact") best = { identifier, matchKind };
      if (matchKind === "exact") break;
    }
    if (best) matches.push({ ...candidate, ...best });
  }
  post({
    type: "inspection-complete",
    requestId: request.requestId,
    identifiers: [...identifiers].slice(0, 64),
    matches,
  });
}

async function parseFile(
  request: Extract<TrackParserRequest, { type: "parse" }>,
  signal: AbortSignal,
): Promise<void> {
  const state = createParseState(request.file, request.targetSequence, { records: 0 });
  await readLines(request.file, signal, (line) => parseLine(state, line), (progress) => {
    post({ type: "progress", requestId: request.requestId, progress, text: `Reading ${request.file.name}` });
  });
  if (signal.aborted) return;
  const report = finish(state);
  if (report.validRecords === 0 || report.tracks.every((track) => track.features.length === 0)) {
    const seen = report.identifiers.length > 0 ? ` Found: ${report.identifiers.slice(0, 8).join(", ")}.` : "";
    post({
      type: "error",
      requestId: request.requestId,
      message: `No valid features matched ${request.targetSequence.name}.${seen}`,
      issues: report.issues,
    });
    return;
  }
  post({ type: "complete", requestId: request.requestId, report });
}

async function parseBatchFile(
  request: Extract<TrackParserRequest, { type: "parse-batch" }>,
  signal: AbortSignal,
): Promise<void> {
  const candidates = [...new Map(request.candidates.map((candidate) => [candidate.index, candidate])).values()];
  const admission: RecordAdmission = { records: 0 };
  const states = new Map(candidates.map((candidate) => [
    candidate.index,
    createParseState(request.file, candidate, admission),
  ]));
  const routedRecords = new Map(candidates.map((candidate) => [candidate.index, 0]));
  const identifiers = new Set<string>();
  const ambiguousIdentifiers = new Set<string>();
  let ambiguousRecords = 0;
  let dataRecords = 0;
  let lineNumber = 0;

  await readLines(request.file, signal, (rawLine) => {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("browser ") || line.startsWith("#")) return;
    if (line.startsWith("track ")) {
      for (const state of states.values()) parseLine(state, rawLine, lineNumber);
      return;
    }
    dataRecords += 1;
    const identifier = rawLine.split("\t", 1)[0]?.trim() ?? "";
    if (identifier) identifiers.add(identifier);
    const resolution = resolveTrackSequenceIdentifier(identifier, candidates);
    if (resolution.kind === "ambiguous") {
      ambiguousRecords += 1;
      if (identifier) ambiguousIdentifiers.add(identifier);
      return;
    }
    if (resolution.kind === "none") return;
    const state = states.get(resolution.candidate.index);
    if (!state) return;
    routedRecords.set(resolution.candidate.index, (routedRecords.get(resolution.candidate.index) ?? 0) + 1);
    parseLine(state, rawLine, lineNumber);
  }, (progress) => {
    post({ type: "progress", requestId: request.requestId, progress, text: `Reading ${request.file.name}` });
  });
  if (signal.aborted) return;

  const results = [];
  const issues: ImportIssue[] = [];
  for (const candidate of candidates) {
    const state = states.get(candidate.index);
    if (!state) continue;
    state.ignoredSequenceRecords = Math.max(0, dataRecords - (routedRecords.get(candidate.index) ?? 0));
    const report = finish(state);
    if (report.validRecords > 0 && report.tracks.some((track) => track.features.length > 0)) {
      results.push({ candidate, report });
    } else {
      issues.push(...report.issues.slice(0, MAX_REPORTED_ISSUES - issues.length));
    }
  }
  if (results.length === 0) {
    const found = identifiers.size > 0 ? ` Found: ${[...identifiers].slice(0, 8).join(", ")}.` : "";
    const ambiguous = ambiguousIdentifiers.size > 0
      ? ` Ambiguous aliases skipped: ${[...ambiguousIdentifiers].slice(0, 8).join(", ")}.`
      : "";
    post({
      type: "error",
      requestId: request.requestId,
      message: `No valid features matched any loaded FASTA record.${found}${ambiguous}`,
      issues,
    });
    return;
  }
  post({
    type: "batch-complete",
    requestId: request.requestId,
    results,
    identifiers: [...identifiers].slice(0, 64),
    ambiguousIdentifiers: [...ambiguousIdentifiers].slice(0, 64),
    ambiguousRecords,
  });
}

function createParseState(
  file: File,
  target: { index: number; name: string; length: number },
  admission: RecordAdmission,
): ParseState {
  return {
    fileName: file.name,
    format: inferFeatureFormat(file.name),
    target,
    lineNumber: 0,
    validRecords: 0,
    skippedRecords: 0,
    clippedRecords: 0,
    ignoredSequenceRecords: 0,
    identifiers: new Set(),
    issues: [],
    exactSeen: false,
    bedTrackName: stripExtension(file.name),
    bedTracks: new Map(),
    transcripts: new Map(),
    genes: new Map(),
    otherGff: [],
    admission,
  };
}

function parseLine(state: ParseState, rawLine: string, lineNumber?: number): void {
  state.lineNumber = lineNumber ?? state.lineNumber + 1;
  const line = rawLine.trim();
  if (!line || line.startsWith("browser ")) return;
  if (line.startsWith("track ")) {
    if (state.format === "bed" || state.format === null) {
      const named = /(?:^|\s)name=(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(line);
      state.bedTrackName = named?.[1] ?? named?.[2] ?? named?.[3] ?? state.bedTrackName;
    }
    return;
  }
  if (line.startsWith("#")) return;
  if (!state.format) state.format = inferFeatureFormat(state.fileName, line);
  if (!state.format) {
    issue(state, "Could not determine BED, GFF3, or GTF format.");
    return;
  }
  if (state.format === "bed") parseBed(state, rawLine);
  else parseGff(state, rawLine, state.format);
}

function parseBed(state: ParseState, line: string): void {
  const fields = line.split("\t");
  if (fields.length < 3) return invalid(state, "BED record has fewer than three tab-separated columns.");
  const [sequenceId = "", startText = "", endText = ""] = fields;
  if (!sequenceId) return invalid(state, "BED sequence identifier is empty.");
  state.identifiers.add(sequenceId);
  const match = sequenceIdentifierMatch(sequenceId, state.target.name);
  if (!match) {
    state.ignoredSequenceRecords += 1;
    return;
  }
  state.exactSeen ||= match === "exact";
  const rawStart = Number(startText);
  const rawEnd = Number(endText);
  if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawStart < 0 || rawEnd <= rawStart) {
    return invalid(state, "BED start/end must be integers with 0 ≤ start < end.");
  }
  const clipped = clipInterval(state, rawStart, rawEnd);
  if (!clipped) return;
  admitRecord(state);
  const [start, end] = clipped;
  const name = fields[3]?.trim() || `${sequenceId}:${rawStart + 1}-${rawEnd}`;
  const strand = parseStrand(fields[5]);
  const parsedColor = parseItemRgb(fields[8]);
  if (fields[8] && fields[8] !== "0" && !parsedColor) {
    issue(state, "Invalid BED itemRgb value; using the default track color.");
  }
  const color = parsedColor ?? DEFAULT_COLOR;
  const blocks = parseBedBlocks(state, fields, rawStart, rawEnd, start, end);
  const thickStartValue = Number(fields[6]);
  const thickEndValue = Number(fields[7]);
  const feature: ImportedFeature = {
    id: `${state.fileName}:${state.lineNumber}`,
    name,
    type: fields.length >= 12 ? "BED12" : "BED",
    start,
    end,
    strand,
    color,
    blocks,
    lane: 0,
    details: [
      fields[4] ? `score ${fields[4]}` : "",
      ...fields.slice(12, 20).map((value, index) => `field ${index + 13}: ${value}`),
    ].filter(Boolean),
  };
  if (Number.isFinite(thickStartValue) && Number.isFinite(thickEndValue) && thickEndValue > thickStartValue) {
    feature.thickStart = Math.max(start, thickStartValue);
    feature.thickEnd = Math.min(end, thickEndValue);
  }
  const features = state.bedTracks.get(state.bedTrackName) ?? [];
  features.push(feature);
  state.bedTracks.set(state.bedTrackName, features);
}

function parseBedBlocks(
  state: ParseState,
  fields: string[],
  rawStart: number,
  rawEnd: number,
  clippedStart: number,
  clippedEnd: number,
): number[] {
  if (fields.length < 12) return [clippedStart, clippedEnd];
  const count = Number(fields[9]);
  const sizes = (fields[10] ?? "").replace(/,$/, "").split(",").map(Number);
  const starts = (fields[11] ?? "").replace(/,$/, "").split(",").map(Number);
  if (!Number.isInteger(count) || count < 1 || sizes.length !== count || starts.length !== count) {
    issue(state, "Invalid BED12 blockCount, blockSizes, or blockStarts; using one block.");
    return [clippedStart, clippedEnd];
  }
  const blocks: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const blockStart = rawStart + (starts[index] ?? Number.NaN);
    const blockEnd = blockStart + (sizes[index] ?? Number.NaN);
    if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd) || blockStart < rawStart || blockEnd > rawEnd || blockEnd <= blockStart) {
      issue(state, "Invalid BED12 block coordinates; using one block.");
      return [clippedStart, clippedEnd];
    }
    const start = Math.max(clippedStart, blockStart);
    const end = Math.min(clippedEnd, blockEnd);
    if (end > start) blocks.push(start, end);
  }
  return blocks.length > 0 ? blocks : [clippedStart, clippedEnd];
}

function parseGff(state: ParseState, line: string, format: "gff3" | "gtf"): void {
  const fields = line.split("\t");
  if (fields.length !== 9) return invalid(state, `${format.toUpperCase()} record must have exactly nine tab-separated columns.`);
  const [sequenceId = "", source = ".", type = "", startText = "", endText = "", score = ".", strandText = ".", phase = ".", rawAttributes = ""] = fields;
  state.identifiers.add(sequenceId);
  const match = sequenceIdentifierMatch(sequenceId, state.target.name);
  if (!match) {
    state.ignoredSequenceRecords += 1;
    return;
  }
  state.exactSeen ||= match === "exact";
  const oneBasedStart = Number(startText);
  const oneBasedEnd = Number(endText);
  if (!Number.isInteger(oneBasedStart) || !Number.isInteger(oneBasedEnd) || oneBasedStart < 1 || oneBasedEnd < oneBasedStart) {
    return invalid(state, `${format.toUpperCase()} coordinates must be integers with 1 ≤ start ≤ end.`);
  }
  const clipped = clipInterval(state, oneBasedStart - 1, oneBasedEnd);
  if (!clipped) return;
  const [start, end] = clipped;
  const attributes = parseAttributes(rawAttributes, format);
  const id = attributes.ID ?? attributes.transcript_id ?? attributes.gene_id ?? `${state.fileName}:${state.lineNumber}`;
  const parents = (attributes.Parent ?? attributes.transcript_id ?? "").split(",").filter(Boolean);
  const name = preferredName(attributes, id);
  if (!type) return invalid(state, `${format.toUpperCase()} feature type is empty.`);
  if (!["+", "-", ".", "?"].includes(strandText)) {
    return invalid(state, `${format.toUpperCase()} strand must be +, -, ., or ?.`);
  }
  if (!["0", "1", "2", "."].includes(phase)) {
    return invalid(state, `${format.toUpperCase()} phase must be 0, 1, 2, or .`);
  }
  admitRecord(state);
  const strand = parseStrand(strandText);
  const details = [
    source !== "." ? `source ${source}` : "",
    score !== "." ? `score ${score}` : "",
    phase !== "." ? `phase ${phase}` : "",
    ...attributeDetails(attributes),
  ].filter(Boolean);
  const lowerType = type.toLowerCase();
  if (lowerType === "gene" || lowerType === "pseudogene") {
    state.genes.set(id, {
      id,
      name,
      start,
      end,
      strand,
      hasTranscript: false,
      details,
      color: gffFeatureColor(type, attributes),
    });
  } else if (isTranscriptType(lowerType)) {
    const builder = transcript(state, id);
    builder.name = name;
    builder.type = type;
    builder.start = start;
    builder.end = end;
    builder.strand = strand;
    builder.parentGene = format === "gtf" ? attributes.gene_id ?? "" : parents[0] ?? attributes.gene_id ?? "";
    builder.details = details;
    builder.color = gffFeatureColor(type, attributes);
    const gene = state.genes.get(builder.parentGene);
    if (gene) gene.hasTranscript = true;
  } else if (lowerType === "exon" || lowerType === "cds" || lowerType.endsWith("utr")) {
    for (const parent of parents) {
      const builder = transcript(state, parent);
      builder.start = Math.min(builder.start, start);
      builder.end = Math.max(builder.end, end);
      if (builder.strand === ".") builder.strand = strand;
      if (lowerType === "exon") builder.blocks.push(start, end);
      if (lowerType === "cds") {
        builder.cdsStart = Math.min(builder.cdsStart ?? start, start);
        builder.cdsEnd = Math.max(builder.cdsEnd ?? end, end);
        if (builder.blocks.length === 0) builder.blocks.push(start, end);
      }
    }
  } else if (parents.length === 0) {
    state.otherGff.push({ id, name, type, start, end, strand, color: gffFeatureColor(type, attributes), blocks: [start, end], lane: 0, details });
  }
}

function admitRecord(state: ParseState): void {
  const next = state.admission.records + 1;
  const admissionError = annotationAdmissionError(0, next);
  if (admissionError) throw new Error(admissionError);
  state.admission.records = next;
  state.validRecords += 1;
}

function transcript(state: ParseState, id: string): TranscriptBuilder {
  let builder = state.transcripts.get(id);
  if (!builder) {
    builder = {
      id,
      name: id,
      type: "transcript",
      start: Number.POSITIVE_INFINITY,
      end: 0,
      strand: ".",
      parentGene: "",
      blocks: [],
      details: [],
      color: OTHER_GENE_COLOR,
    };
    state.transcripts.set(id, builder);
  }
  return builder;
}

function finish(state: ParseState): TrackImportReport {
  const tracks: ImportedLogicalTrack[] = [];
  if (state.format === "bed") {
    for (const [name, features] of state.bedTracks) {
      tracks.push({ name, features, maximumLane: assignFeatureLanes(features) });
    }
  } else {
    const features = state.otherGff;
    for (const builder of state.transcripts.values()) {
      if (!Number.isFinite(builder.start) || builder.end <= builder.start) continue;
      const gene = state.genes.get(builder.parentGene);
      if (gene) gene.hasTranscript = true;
      const blocks = normalizedBlocks(builder.blocks, builder.start, builder.end);
      features.push({
        id: builder.id,
        name: gene?.name || builder.name,
        type: builder.type,
        start: builder.start,
        end: builder.end,
        strand: builder.strand,
        color: gene?.color ?? builder.color,
        blocks,
        thickStart: builder.cdsStart,
        thickEnd: builder.cdsEnd,
        lane: 0,
        details: [...builder.details, builder.name !== gene?.name ? `transcript ${builder.name}` : ""].filter(Boolean),
      });
    }
    for (const gene of state.genes.values()) {
      if (gene.hasTranscript) continue;
      features.push({
        id: gene.id,
        name: gene.name,
        type: "gene",
        start: gene.start,
        end: gene.end,
        strand: gene.strand,
        color: gene.color,
        blocks: [gene.start, gene.end],
        lane: 0,
        details: gene.details,
      });
    }
    if (features.length > 0) {
      tracks.push({ name: stripExtension(state.fileName), features, maximumLane: assignFeatureLanes(features) });
    }
  }
  return {
    fileName: state.fileName,
    format: state.format ?? "bed",
    sequenceName: state.target.name,
    matchedIdentifier: [...state.identifiers].find((identifier) => sequenceIdentifierMatch(identifier, state.target.name) !== null) ?? state.target.name,
    matchKind: state.exactSeen ? "exact" : "alias",
    validRecords: state.validRecords,
    skippedRecords: state.skippedRecords,
    clippedRecords: state.clippedRecords,
    ignoredSequenceRecords: state.ignoredSequenceRecords,
    identifiers: [...state.identifiers].slice(0, 64),
    issues: state.issues,
    tracks,
  };
}

function normalizedBlocks(blocks: number[], start: number, end: number): number[] {
  if (blocks.length === 0) return [start, end];
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index + 1 < blocks.length; index += 2) {
    const blockStart = Math.max(start, blocks[index] ?? start);
    const blockEnd = Math.min(end, blocks[index + 1] ?? end);
    if (blockEnd > blockStart) pairs.push([blockStart, blockEnd]);
  }
  pairs.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return pairs.flat();
}

function parseAttributes(raw: string, format: "gff3" | "gtf"): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (format === "gff3") {
      const equals = trimmed.indexOf("=");
      if (equals < 1) continue;
      const key = trimmed.slice(0, equals);
      const value = trimmed.slice(equals + 1);
      try {
        attributes[key] = decodeURIComponent(value.replace(/\+/g, "%20"));
      } catch {
        attributes[key] = value;
      }
    } else {
      const match = /^(\S+)\s+"?([^"]*)"?$/.exec(trimmed);
      if (match?.[1]) attributes[match[1]] = match[2] ?? "";
    }
  }
  return attributes;
}

function preferredName(attributes: Record<string, string>, fallback: string): string {
  return attributes.gene_name
    ?? attributes.Name
    ?? attributes.gene
    ?? attributes.product
    ?? attributes.transcript_name
    ?? fallback;
}

function attributeDetails(attributes: Record<string, string>): string[] {
  const structural = new Set([
    "ID", "Parent", "Name", "gene_name", "gene", "transcript_name", "gene_id", "transcript_id",
  ]);
  return Object.entries(attributes)
    .filter(([key]) => !structural.has(key))
    .slice(0, 10)
    .map(([key, value]) => `${key} ${value}`);
}

function isTranscriptType(type: string): boolean {
  return type === "mrna" || type === "transcript" || type.endsWith("transcript") || type.endsWith("_rna") || type === "rna";
}

function parseStrand(value: string | undefined): "+" | "-" | "." {
  return value === "+" || value === "-" ? value : ".";
}

function clipInterval(state: ParseState, start: number, end: number): [number, number] | null {
  if (start >= state.target.length || end <= 0) {
    invalid(state, "Feature lies outside the selected sequence and was skipped.");
    return null;
  }
  const clippedStart = Math.max(0, start);
  const clippedEnd = Math.min(state.target.length, end);
  if (clippedStart !== start || clippedEnd !== end) state.clippedRecords += 1;
  return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
}

function invalid(state: ParseState, message: string): void {
  state.skippedRecords += 1;
  issue(state, message);
}

function issue(state: ParseState, message: string): void {
  if (state.issues.length < MAX_REPORTED_ISSUES) state.issues.push({ line: state.lineNumber, message });
}

function stripExtension(name: string): string {
  return name.replace(/\.(?:bed|gff3?|gff2|gtf)(?:\.txt)?(?:\.(?:gz|bgz|bgzf))?$/i, "") || "Imported features";
}

async function readLines(
  file: File,
  signal: AbortSignal,
  consume: (line: string) => void,
  progress: (fraction: number) => void,
): Promise<void> {
  if (signal.aborted) return;
  const compressed = /\.(?:gz|bgz|bgzf)$/i.test(file.name);
  let bytesRead = 0;
  let lastPercentage = -1;
  const reportBytes = (): void => {
    const fraction = file.size > 0 ? Math.min(1, bytesRead / file.size) : 1;
    const percentage = Math.floor(fraction * 100);
    if (!signal.aborted && percentage !== lastPercentage) {
      lastPercentage = percentage;
      progress(fraction);
    }
  };
  let stream: ReadableStream<Uint8Array> = file.stream();
  if (compressed) {
    if (!("DecompressionStream" in globalThis)) {
      throw new Error("This browser cannot decompress gzip annotation files; use an uncompressed BED, GFF, or GTF file.");
    }
    stream = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        reportBytes();
        controller.enqueue(chunk);
      },
    }));
    if (await isBgzfBlob(file)) {
      stream = decompressBgzfStream(stream);
    } else {
      const gzipBytes = stream as unknown as ReadableStream<BufferSource>;
      stream = gzipBytes.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>;
    }
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let chunksSinceYield = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel(signal.reason);
        return;
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!compressed) {
        bytesRead += chunk.value.byteLength;
        reportBytes();
      }
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
      chunksSinceYield += 1;
      if (chunksSinceYield >= 16) {
        chunksSinceYield = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  } catch (error: unknown) {
    if (signal.aborted) return;
    if (!compressed) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not decompress ${file.name} as gzip/BGZF: ${reason}`);
  }
  if (signal.aborted) return;
  pending += decoder.decode();
  if (pending.length > 0) consume(pending);
  if (lastPercentage < 100) progress(1);
}

function post(message: TrackParserMessage): void {
  workerScope.postMessage(message);
}
