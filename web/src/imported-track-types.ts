import type { FeatureTrackAxis } from "./protocol";

export type ImportedTrackFormat = "bed" | "gff3" | "gtf";

/** Maximum annotation bytes admitted to one parser job. */
export const MAX_IMPORTED_ANNOTATION_BYTES = 512 * 1024 * 1024;

/** Maximum matching annotation records admitted to one imported file. */
export const MAX_IMPORTED_ANNOTATION_RECORDS = 1_000_000;

export function annotationAdmissionError(fileBytes: number, matchingRecords: number): string | null {
  if (fileBytes > MAX_IMPORTED_ANNOTATION_BYTES) {
    return `Annotation files are limited to ${MAX_IMPORTED_ANNOTATION_BYTES.toLocaleString()} bytes.`;
  }
  if (matchingRecords > MAX_IMPORTED_ANNOTATION_RECORDS) {
    return `Annotation imports are limited to ${MAX_IMPORTED_ANNOTATION_RECORDS.toLocaleString()} matching records per file.`;
  }
  return null;
}

export interface ImportedFeature {
  id: string;
  name: string;
  type: string;
  start: number;
  end: number;
  strand: "+" | "-" | ".";
  color: string;
  /** Alternating zero-based half-open block starts and ends. */
  blocks: number[];
  thickStart?: number;
  thickEnd?: number;
  lane: number;
  details: string[];
}

export interface ImportedLogicalTrack {
  name: string;
  features: ImportedFeature[];
  maximumLane: number;
}

export interface ImportIssue {
  line: number;
  message: string;
}

export interface TrackImportReport {
  fileName: string;
  format: ImportedTrackFormat;
  sequenceName: string;
  matchedIdentifier: string;
  matchKind: "exact" | "alias";
  validRecords: number;
  skippedRecords: number;
  clippedRecords: number;
  ignoredSequenceRecords: number;
  identifiers: string[];
  issues: ImportIssue[];
  tracks: ImportedLogicalTrack[];
}

export interface TrackSequenceCandidate {
  axis: FeatureTrackAxis;
  index: number;
  name: string;
  length: number;
}

export type TrackSequenceResolution =
  | {
      kind: "match";
      candidate: TrackSequenceCandidate;
      matchKind: "exact" | "alias";
    }
  | { kind: "ambiguous"; candidates: TrackSequenceCandidate[] }
  | { kind: "none" };

export interface BatchTrackImportResult {
  candidate: TrackSequenceCandidate;
  report: TrackImportReport;
}

export type TrackParserRequest =
  | { type: "cancel"; requestIds: number[] }
  | {
      type: "parse";
      requestId: number;
      file: File;
      targetSequence: { index: number; name: string; length: number };
    }
  | {
      type: "parse-batch";
      requestId: number;
      file: File;
      candidates: TrackSequenceCandidate[];
    }
  | {
      type: "inspect";
      requestId: number;
      file: File;
      candidates: TrackSequenceCandidate[];
    };

export type TrackParserMessage =
  | { type: "progress"; requestId: number; progress: number; text: string }
  | {
      type: "inspection-complete";
      requestId: number;
      identifiers: string[];
      matches: Array<TrackSequenceCandidate & { identifier: string; matchKind: "exact" | "alias" }>;
    }
  | {
      type: "batch-complete";
      requestId: number;
      results: BatchTrackImportResult[];
      identifiers: string[];
      ambiguousIdentifiers: string[];
      ambiguousRecords: number;
    }
  | { type: "complete"; requestId: number; report: TrackImportReport }
  | { type: "error"; requestId: number; message: string; issues: ImportIssue[] };

export function inferFeatureFormat(fileName: string, firstDataLine = ""): ImportedTrackFormat | null {
  const lower = fileName.toLowerCase().replace(/\.(?:gz|bgz|bgzf)$/, "");
  if (/\.(bed)(?:\.txt)?$/.test(lower)) return "bed";
  if (/\.(gff|gff3)(?:\.txt)?$/.test(lower)) return "gff3";
  if (/\.(gtf|gff2)(?:\.txt)?$/.test(lower)) return "gtf";
  const fields = firstDataLine.split("\t");
  if (fields.length >= 9 && /^[+-\.]$/.test(fields[6] ?? "")) {
    return (fields[8] ?? "").includes("=") ? "gff3" : "gtf";
  }
  if (fields.length >= 3 && /^\d+$/.test(fields[1] ?? "") && /^\d+$/.test(fields[2] ?? "")) {
    return "bed";
  }
  return null;
}

/** Conservative chromosome aliases only; arbitrary fuzzy matching is intentionally excluded. */
export function normalizedSequenceIdentifier(identifier: string): string {
  const token = identifier.trim().split(/\s+/, 1)[0] ?? "";
  const withoutPrefix = token.replace(/^chr/i, "");
  return /^(m|mt)$/i.test(withoutPrefix) ? "MT" : withoutPrefix.toUpperCase();
}

export function sequenceIdentifierMatch(
  recordIdentifier: string,
  sequenceName: string,
): "exact" | "alias" | null {
  const sequenceIdentifier = sequenceName.trim().split(/\s+/, 1)[0] ?? sequenceName;
  if (recordIdentifier === sequenceIdentifier || recordIdentifier === sequenceName) return "exact";
  return normalizedSequenceIdentifier(recordIdentifier) === normalizedSequenceIdentifier(sequenceIdentifier)
    ? "alias"
    : null;
}

/** Resolves one annotation identifier without ever copying a record to multiple sequences. */
export function resolveTrackSequenceIdentifier(
  recordIdentifier: string,
  candidates: readonly TrackSequenceCandidate[],
): TrackSequenceResolution {
  const exact: TrackSequenceCandidate[] = [];
  const aliases: TrackSequenceCandidate[] = [];
  const seenExact = new Set<number>();
  const seenAliases = new Set<number>();
  for (const candidate of candidates) {
    const matchKind = sequenceIdentifierMatch(recordIdentifier, candidate.name);
    if (matchKind === "exact" && !seenExact.has(candidate.index)) {
      seenExact.add(candidate.index);
      exact.push(candidate);
    } else if (matchKind === "alias" && !seenAliases.has(candidate.index)) {
      seenAliases.add(candidate.index);
      aliases.push(candidate);
    }
  }
  const preferred = exact.length > 0 ? exact : aliases;
  if (preferred.length === 1) {
    return {
      kind: "match",
      candidate: preferred[0] as TrackSequenceCandidate,
      matchKind: exact.length > 0 ? "exact" : "alias",
    };
  }
  if (preferred.length > 1) return { kind: "ambiguous", candidates: preferred };
  return { kind: "none" };
}

export function parseItemRgb(value: string | undefined): string | null {
  if (!value || value === "0") return null;
  const channels = value.split(",").map(Number);
  if (channels.length !== 3 || channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return null;
  }
  return `rgb(${channels.join(", ")})`;
}

export function gffFeatureColor(type: string, attributes: Record<string, string>): string {
  const category = [
    type,
    attributes.gene_biotype,
    attributes.gene_type,
    attributes.biotype,
    attributes.transcript_biotype,
    attributes.transcript_type,
  ].filter(Boolean).join(" ").toLowerCase();
  if (category.includes("pseudogene") || category.includes("pseudogenic")) return "#4f78a8";
  if (category.includes("protein_coding") || category.includes("protein coding") || type.toLowerCase() === "mrna") {
    return "#173f73";
  }
  if (category.includes("rna")) return "#397a4c";
  return "#45464a";
}

export function trackAxisEligible(
  associatedSequenceIndex: number,
  axis: FeatureTrackAxis,
  xIndex: number,
  yIndex: number,
): boolean {
  return trackCollectionAxisEligible([associatedSequenceIndex], axis, xIndex, yIndex);
}

/** True when a logical, multi-sequence track has data for the sequence on an axis. */
export function trackCollectionAxisEligible(
  associatedSequenceIndexes: Iterable<number>,
  axis: FeatureTrackAxis,
  xIndex: number,
  yIndex: number,
): boolean {
  const selectedIndex = axis === "x" ? xIndex : yIndex;
  for (const sequenceIndex of associatedSequenceIndexes) {
    if (sequenceIndex === selectedIndex) return true;
  }
  return false;
}

/** Assigns deterministic, unbounded greedy lanes. Display code folds excess lanes into its final row. */
export function assignFeatureLanes(features: ImportedFeature[]): number {
  const laneEnds: number[] = [];
  features.sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
  for (const feature of features) {
    let lane = laneEnds.findIndex((end) => end <= feature.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(feature.end);
    } else {
      laneEnds[lane] = feature.end;
    }
    feature.lane = lane;
  }
  return Math.max(0, laneEnds.length - 1);
}
