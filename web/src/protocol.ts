export interface SequenceMetadata {
  index: number;
  name: string;
  length: number;
}

export interface ComparisonParameters {
  xIndex: number;
  yIndex: number;
  resolution: number;
  previewRegisterCount: number;
  detailedRegisterCount: number;
  k: number;
}

export interface TileCoordinate {
  x: number;
  y: number;
}

export interface CachedTileCoordinate extends TileCoordinate {
  resolution: number;
}

export type MainToWorkerMessage =
  | { type: "load"; files: File[] }
  | { type: "prepare"; generation: number; requestId: number; parameters: ComparisonParameters }
  | { type: "cancel-tiles"; generation: number; requestId: number }
  | { type: "preview-presented"; generation: number; requestId: number }
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
      tiles: TileCoordinate[];
    }
  | { type: "clear" };

export interface MatrixTilePayload {
  generation: number;
  quality: "preview" | "refined" | "exact";
  resolution: number;
  x: number;
  y: number;
  width: number;
  height: number;
  identity: Uint16Array;
  direction: Int16Array;
  directionSupport: Uint16Array;
  /** X-axis base codes (A=0, C=1, G=2, T=3, N/padding=4) for exact tiles. */
  bases?: Uint8Array;
}

export type WorkerToMainMessage =
  | { type: "ready" }
  | { type: "status"; text: string; progress?: number; busy?: boolean }
  | { type: "sequences"; sequences: SequenceMetadata[] }
  | { type: "comparison-ready"; generation: number; parameters: ComparisonParameters }
  | { type: "preview-complete"; generation: number; requestId: number }
  | ({ type: "tile" } & MatrixTilePayload)
  | { type: "complete"; generation: number; elapsedMs: number; estimatedBytes: number }
  | { type: "memory"; estimatedBytes: number }
  | { type: "error"; message: string };
