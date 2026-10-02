import type { ScientificConfig } from "./wasm/moddotplot_wasm.js";
import type { ComparisonParameters, SequenceMetadata } from "./protocol";
import type { RefinementEvidence } from "./refinement";

export type JobKind = "dataset" | "comparison" | "feature";

let nextJobSerial = 1;

function immutableJobId(kind: JobKind, generation: number, requestId?: number): string {
  const request = requestId === undefined ? "dataset" : requestId.toString(36);
  const serial = nextJobSerial.toString(36);
  nextJobSerial += 1;
  return `${kind}:${generation.toString(36)}:${request}:${serial}`;
}

abstract class OwnedJob {
  readonly id: string;
  readonly generation: number;
  readonly controller = new AbortController();

  protected constructor(kind: JobKind, generation: number, requestId?: number) {
    this.id = immutableJobId(kind, generation, requestId);
    this.generation = generation;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(reason: string): void {
    if (!this.signal.aborted) this.controller.abort(reason);
  }
}

export class DatasetSession extends OwnedJob {
  sequences: SequenceMetadata[] = [];

  constructor(generation: number) {
    super("dataset", generation);
  }

  canPublish(generation: number): boolean {
    return !this.signal.aborted && generation === this.generation;
  }

  /** A loaded dataset remains usable by comparisons with newer generation numbers. */
  canServe(): boolean {
    return !this.signal.aborted;
  }
}

export class ComparisonJob extends OwnedJob {
  readonly requestId: number;
  readonly parameters: Readonly<ComparisonParameters>;
  readonly configurations = new Map<number, ScientificConfig>();
  readonly publishedTiles = new Set<string>();
  readonly refinementEvidence = new Map<string, RefinementEvidence>();
  refinementDisplayMinimum = 8_500;
  preparationToken = 0;
  pendingPresentation: { resolve: () => void } | null = null;
  activeTileRequestId: number;
  private tileRequestController = new AbortController();

  constructor(
    generation: number,
    requestId: number,
    parameters: ComparisonParameters,
  ) {
    super("comparison", generation, requestId);
    this.requestId = requestId;
    this.activeTileRequestId = requestId;
    this.parameters = Object.freeze({ ...parameters });
  }

  canPublish(generation: number, requestId: number): boolean {
    return !this.signal.aborted
      && !this.tileRequestController.signal.aborted
      && generation === this.generation
      && requestId === this.activeTileRequestId;
  }

  get tileSignal(): AbortSignal {
    return this.tileRequestController.signal;
  }

  beginTileRequest(requestId: number): void {
    this.tileRequestController.abort("tile request superseded");
    this.tileRequestController = new AbortController();
    this.activeTileRequestId = requestId;
    this.releasePresentation();
  }

  cancelTileRequest(requestId: number): void {
    this.activeTileRequestId = requestId;
    this.tileRequestController.abort("tile request cancelled");
    this.releasePresentation();
  }

  releasePresentation(): void {
    const pending = this.pendingPresentation;
    this.pendingPresentation = null;
    pending?.resolve();
  }

  override cancel(reason: string): void {
    this.releasePresentation();
    this.tileRequestController.abort(reason);
    for (const config of this.configurations.values()) config.free();
    this.configurations.clear();
    super.cancel(reason);
  }
}

export class FeatureJob extends OwnedJob {
  readonly requestId: number;

  constructor(generation: number, requestId: number) {
    super("feature", generation, requestId);
    this.requestId = requestId;
  }

  canPublish(generation: number, requestId: number): boolean {
    return !this.signal.aborted
      && generation === this.generation
      && requestId === this.requestId;
  }
}

export class SerializedWorkerQueue {
  private revision = 0;
  private executingRevision = 0;

  invalidate(): number {
    this.revision += 1;
    return this.revision;
  }

  ticket(): number {
    return this.revision;
  }

  begin(revision: number): void {
    this.executingRevision = revision;
  }

  isCurrent(): boolean {
    return this.executingRevision === this.revision;
  }
}
