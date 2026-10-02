import type { ExactKmerGeometry } from "./exact-mode";
import type { PrecomputedOverviewArtifact } from "./precomputed-overview";

export interface SequenceMetadata {
  index: number;
  /** FASTA identifier ending at the first header whitespace. */
  name: string;
  description: string;
  length: number;
  sourceFile: string;
  /** Source-qualified, load-unique identifier used by selectors and filenames. */
  selectionId: string;
}

export interface ComparisonParameters {
  xIndex: number;
  yIndex: number;
  resolution: number;
  previewRegisterCount: number;
  detailedRegisterCount: number;
  k: number;
  exactGeometry: ExactKmerGeometry;
}

export interface ScientificConfigMetadata {
  version: number;
  digest: string;
  /** Full canonical scientific field encoding; authoritative cache compatibility key. */
  identity: string;
  hashAlgorithm: string;
  hashSeed: string;
  estimator: string;
  k: number;
  registerCount: number;
  hllPrecision: number;
  bBits: number;
  verificationBits: number;
  identityScale: number;
  missingIdentity: number;
}

export interface TileCoordinate {
  x: number;
  y: number;
}

export interface CachedTileCoordinate extends TileCoordinate {
  resolution: number;
}

export type FeatureTrackAxis = "x" | "y";
export type FeatureTrackKind = "gc" | "cpg";

export interface FeatureTrackRequest {
  kind: FeatureTrackKind;
  axis: FeatureTrackAxis;
  sequenceIndex: number;
  start: number;
  end: number;
  bins: number;
}

export interface FeatureTrackPayload {
  kind: FeatureTrackKind;
  axis: FeatureTrackAxis;
  start: number;
  end: number;
  values: Float64Array;
}

/** Same-origin FASTA retained as a lazy HTTP byte-range source. */
export interface RemoteFastaSourceDescriptor {
  url: string;
  fileName: string;
  byteLength: number;
}

export type MainToWorkerMessage =
  | { type: "load"; generation: number; files: File[] }
  | {
      type: "load-precomputed-overview";
      generation: number;
      source: RemoteFastaSourceDescriptor;
      artifact: PrecomputedOverviewArtifact;
    }
  | {
      type: "cache-precomputed-overview";
      generation: number;
      artifact: PrecomputedOverviewArtifact;
    }
  | { type: "prepare"; generation: number; requestId: number; parameters: ComparisonParameters }
  | { type: "cancel-tiles"; generation: number; requestId: number }
  | { type: "preview-presented"; generation: number; requestId: number }
  | { type: "update-refinement-policy"; generation: number; displayMinimum: number }
  | { type: "cancel-feature-tracks"; generation: number; requestId: number }
  | {
      type: "request-feature-tracks";
      generation: number;
      requestId: number;
      tracks: FeatureTrackRequest[];
    }
  | {
      type: "evict-tiles";
      generation: number;
      tiles: CachedTileCoordinate[];
    }
  | {
      type: "request-tiles";
      generation: number;
      requestId: number;
      resolution: number;
      mode: "sketch" | "kmer";
      exactGeometry: ExactKmerGeometry;
      tiles: TileCoordinate[];
      forceDetailed?: boolean;
    }
  | { type: "clear"; generation: number };

export interface MatrixTilePayload {
  generation: number;
  configDigest: string;
  quality: "preview" | "refined" | "exact";
  resolution: number;
  x: number;
  y: number;
  width: number;
  height: number;
  identity: Uint16Array;
  direction: Int16Array;
  directionSupport: Uint16Array;
  /** X-sequence base codes (A=0, C=1, G=2, T=3, N/padding=4) for exact tiles. */
  bases?: Uint8Array;
}

export type WorkerToMainMessage =
  | { type: "ready" }
  | { type: "status"; generation: number; text: string; progress?: number; busy?: boolean }
  | { type: "precomputed-overview-cached"; generation: number; resolution: number }
  | { type: "sequences"; generation: number; sequences: SequenceMetadata[] }
  | {
      type: "comparison-ready";
      generation: number;
      parameters: ComparisonParameters;
      configurations: ScientificConfigMetadata[];
    }
  | { type: "preview-complete"; generation: number; requestId: number }
  | { type: "export-ready"; generation: number; requestId: number }
  | {
      type: "feature-track-status";
      generation: number;
      requestId: number;
      text: string;
      progress: number;
    }
  | {
      type: "feature-tracks";
      generation: number;
      requestId: number;
      tracks: FeatureTrackPayload[];
      estimatedBytes: number;
    }
  | ({ type: "tile" } & MatrixTilePayload)
  | {
      type: "complete";
      generation: number;
      elapsedMs: number;
      estimatedBytes: number;
      precomputed?: boolean;
    }
  | { type: "memory"; estimatedBytes: number }
  | { type: "error"; message: string };
