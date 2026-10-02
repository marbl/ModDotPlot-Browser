import { formatInterval } from "./format";
import {
  trackCollectionAxisEligible,
  type BatchTrackImportResult,
  type ImportedFeature,
  type ImportedLogicalTrack,
  type TrackImportReport,
  type TrackParserMessage,
  type TrackParserRequest,
  type TrackSequenceCandidate,
} from "./imported-track-types";
import type { FeatureTrackMetadata } from "./feature-track";
import type { FeatureTrackAxis, SequenceMetadata } from "./protocol";
import type { ViewChange } from "./renderer";

const COMPUTED_TRACK_SIZE = 28;
const LANE_SIZE = 9;
const MIN_IMPORTED_TRACK_SIZE = 18;
const MAX_LANES = 10;

interface ImportedSequenceTrackData extends ImportedLogicalTrack {
  sequenceIndex: number;
  sequenceName: string;
  format: TrackImportReport["format"];
  prefixMaximumEnds: number[];
}

interface ImportedTrackState {
  id: number;
  sourceId: number | null;
  name: string;
  fileName: string;
  format: TrackImportReport["format"];
  sequenceData: Map<number, ImportedSequenceTrackData>;
  lanes: number;
  enabled: Record<FeatureTrackAxis, boolean>;
  inputs: Record<FeatureTrackAxis, HTMLInputElement>;
  bothInput: HTMLInputElement;
  panels: Record<FeatureTrackAxis, HTMLElement>;
  canvases: Record<FeatureTrackAxis, HTMLCanvasElement>;
  hitTargets: Record<FeatureTrackAxis, FeatureHit[]>;
  row: HTMLElement;
  detail: HTMLElement;
}

interface FeatureHit {
  left: number;
  top: number;
  right: number;
  bottom: number;
  feature: ImportedFeature;
}

interface BatchAliasConfirmation {
  sourceId: number;
  results: BatchTrackImportResult[];
  ambiguousRecords: number;
  ambiguousIdentifiers: string[];
}

type PendingImport =
  | { kind: "parse"; axis: FeatureTrackAxis; sequence: SequenceTarget }
  | { kind: "batch"; sourceId: number };

type SequenceTarget = Pick<SequenceMetadata, "index" | "name" | "length">;

export interface ImportedTrackManagerOptions {
  xStack: HTMLElement;
  yStack: HTMLElement;
  xDropTargets: HTMLElement[];
  yDropTargets: HTMLElement[];
  list: HTMLElement;
  emptyMessage: HTMLElement;
  addButton: HTMLButtonElement;
  input: HTMLInputElement;
  dialog: HTMLDialogElement;
  dialogTitle: HTMLElement;
  dialogSummary: HTMLElement;
  dialogDetails: HTMLElement;
  dialogConfirm: HTMLButtonElement;
  dialogSecondary: HTMLButtonElement;
  dialogClose: HTMLButtonElement;
  tooltip: HTMLElement;
  getSequence(axis: FeatureTrackAxis): SequenceMetadata | null;
  getSequences(): readonly SequenceMetadata[];
  onLayoutChange(): void;
  onStatus(text: string, progress?: number): void;
  onIdle(): void;
}

/** Owns imported annotation data, controls, rendering, and direct manipulation in the track strips. */
export class ImportedTrackManager {
  readonly #options: ImportedTrackManagerOptions;
  #worker: Worker | null = null;
  readonly #tracks: ImportedTrackState[] = [];
  readonly #pending = new Map<number, PendingImport>();
  readonly #resizeObserver: ResizeObserver;
  #nextRequestId = 0;
  #nextTrackId = 0;
  #nextSourceId = 0;
  #metadata: FeatureTrackMetadata | null = null;
  #view: ViewChange | null = null;
  readonly #batchAliasConfirmations: BatchAliasConfirmation[] = [];
  #batchAliasConfirmationActive = false;

  constructor(options: ImportedTrackManagerOptions) {
    this.#options = options;
    this.#resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const panel = entry.target as HTMLElement;
        const track = this.#tracks.find((candidate) => candidate.panels.x === panel || candidate.panels.y === panel);
        if (track) this.#draw(track, track.panels.x === panel ? "x" : "y");
      }
    });
    this.#wireInputs();
    this.#wireDrops(options.xDropTargets, "x");
    this.#wireDrops(options.yDropTargets, "y");
    this.#wireGlobalFileDropGuard();
    options.dialogClose.addEventListener("click", () => options.dialog.close());
    options.dialog.addEventListener("close", () => {
      this.#batchAliasConfirmationActive = false;
      queueMicrotask(() => this.#showNextBatchAliasConfirmation());
    });
  }

  setView(metadata: FeatureTrackMetadata, view: ViewChange): void {
    const contextChanged = !this.#metadata
      || this.#metadata.xIndex !== metadata.xIndex
      || this.#metadata.yIndex !== metadata.yIndex;
    this.#metadata = metadata;
    this.#view = view;
    if (contextChanged) this.#updateEligibilityAndDraw();
    else {
      for (const track of this.#tracks) {
        if (!track.panels.x.hidden) this.#draw(track, "x");
        if (!track.panels.y.hidden) this.#draw(track, "y");
      }
    }
  }

  updateSequenceContext(metadata: FeatureTrackMetadata | null): void {
    this.#metadata = metadata;
    this.#updateEligibilityAndDraw();
  }

  registerComputedPanel(
    panel: HTMLElement,
    axis: FeatureTrackAxis,
    disable: () => void,
  ): void {
    panel.dataset.trackSize = String(COMPUTED_TRACK_SIZE);
    this.#makeDraggable(panel, axis, disable);
  }

  showQuantitativeHover(
    hover: { label: string; value: string; start: number; end: number } | null,
    event: PointerEvent,
  ): void {
    if (!hover) {
      this.#options.tooltip.hidden = true;
      return;
    }
    this.#setTooltip([hover.label, hover.value, formatInterval(hover.start, hover.end)], event);
  }

  estimatedBytes(): number {
    return this.#tracks.reduce((total, track) => total + [...track.sequenceData.values()].reduce(
      (sequenceTotal, sequence) => sequenceTotal + sequence.features.reduce(
        (featureTotal, feature) => featureTotal + 160 + feature.blocks.length * 8 + feature.details.join("").length * 2,
        0,
      ),
      0,
    ), 0);
  }

  /** Imports files using the same sequence-matching flow as the Add track picker. */
  importFiles(files: readonly File[]): void {
    if (files.length > 0) this.#autoImportFiles([...files]);
  }

  /** Matches launch-screen annotations against every record in the loaded FASTA set. */
  importFilesForSequences(files: readonly File[], sequences: readonly SequenceMetadata[]): void {
    if (files.length === 0 || sequences.length === 0) return;
    const x = this.#options.getSequence("x");
    const candidates: TrackSequenceCandidate[] = sequences.map((sequence) => ({
      axis: sequence.index === x?.index ? "x" : "y",
      index: sequence.index,
      name: sequence.name,
      length: sequence.length,
    }));
    for (const file of files) this.#startBatchParse(file, candidates);
    this.#options.onStatus(`Reading ${files[0]?.name ?? "feature track"}`);
  }

  clear(): void {
    for (const track of this.#tracks) {
      this.#resizeObserver.unobserve(track.panels.x);
      this.#resizeObserver.unobserve(track.panels.y);
      track.panels.x.remove();
      track.panels.y.remove();
      track.row.remove();
    }
    this.#tracks.length = 0;
    if (this.#worker && this.#pending.size > 0) {
      const request: TrackParserRequest = {
        type: "cancel",
        requestIds: [...this.#pending.keys()],
      };
      this.#worker.postMessage(request);
    }
    this.#pending.clear();
    this.#batchAliasConfirmations.length = 0;
    if (this.#batchAliasConfirmationActive && this.#options.dialog.open) this.#options.dialog.close();
    this.#batchAliasConfirmationActive = false;
    this.#options.emptyMessage.hidden = false;
    this.#options.tooltip.hidden = true;
    this.#options.onLayoutChange();
  }

  #wireInputs(): void {
    this.#options.addButton.addEventListener("click", () => this.#options.input.click());
    this.#options.input.addEventListener("change", () => {
      const files = [...(this.#options.input.files ?? [])];
      this.#options.input.value = "";
      this.importFiles(files);
    });
  }

  #wireDrops(targets: HTMLElement[], axis: FeatureTrackAxis): void {
    for (const target of targets) {
      target.dataset.trackDropAxis = axis;
      target.dataset.trackDropLabel = `Drop track on ${axis.toUpperCase()}`;
    }
  }

  #wireGlobalFileDropGuard(): void {
    const targets = [...this.#options.xDropTargets, ...this.#options.yDropTargets];
    const clearFeedback = (): void => {
      document.body.classList.remove("is-feature-file-dragging");
      for (const target of targets) target.classList.remove("is-track-drop-target");
    };
    document.addEventListener("dragover", (event) => {
      if (!hasFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      document.body.classList.add("is-feature-file-dragging");
      const target = closestDropTarget(event.target);
      for (const candidate of targets) candidate.classList.toggle("is-track-drop-target", candidate === target);
      if (event.dataTransfer) event.dataTransfer.dropEffect = target ? "copy" : "none";
    });
    document.addEventListener("dragleave", (event) => {
      if (event.relatedTarget === null) clearFeedback();
    });
    document.addEventListener("drop", (event) => {
      if (!hasFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      const target = closestDropTarget(event.target);
      const files = [...(event.dataTransfer?.files ?? [])];
      clearFeedback();
      if (target) {
        const axis = target.dataset.trackDropAxis;
        if ((axis === "x" || axis === "y") && files.length > 0) this.#importFiles(files, axis);
        return;
      }
      this.#showReport(
        "Track not imported",
        "Feature files must be dropped on the X or Y coordinate axis.",
        ["Use Add track in the Feature tracks panel if you want the application to choose the axis."],
      );
    });
  }

  #autoImportFiles(files: File[]): void {
    const sequences = this.#options.getSequences();
    if (sequences.length === 0) {
      this.#showReport("Track import unavailable", "Load a FASTA sequence before importing a feature track.", []);
      return;
    }
    const x = this.#options.getSequence("x");
    const y = this.#options.getSequence("y");
    const candidates: TrackSequenceCandidate[] = sequences.map((sequence) => ({
      axis: sequence.index === y?.index && sequence.index !== x?.index ? "y" : "x",
      index: sequence.index,
      name: sequence.name,
      length: sequence.length,
    }));
    for (const file of files) {
      this.#startBatchParse(file, candidates);
    }
    this.#options.onStatus(`Matching ${files[0]?.name ?? "feature track"}`);
  }

  #startBatchParse(file: File, candidates: TrackSequenceCandidate[]): void {
    const requestId = ++this.#nextRequestId;
    this.#pending.set(requestId, { kind: "batch", sourceId: ++this.#nextSourceId });
    const request: TrackParserRequest = { type: "parse-batch", requestId, file, candidates };
    this.#parserWorker().postMessage(request);
  }

  #importFiles(files: File[], axis: FeatureTrackAxis): void {
    const sequence = this.#options.getSequence(axis);
    if (!sequence) {
      this.#showReport("Track import unavailable", "Load a FASTA sequence before importing a feature track.", []);
      return;
    }
    for (const file of files) this.#startParse(file, axis, sequence);
    this.#options.onStatus(`Reading ${files[0]?.name ?? "feature track"}`);
  }

  #startParse(file: File, axis: FeatureTrackAxis, sequence: SequenceTarget): void {
    const requestId = ++this.#nextRequestId;
    this.#pending.set(requestId, { kind: "parse", axis, sequence });
    const request: TrackParserRequest = { type: "parse", requestId, file, targetSequence: sequence };
    this.#parserWorker().postMessage(request);
    this.#options.onStatus(`Reading ${file.name}`);
  }

  #parserWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./track-parser-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<TrackParserMessage>) => this.#handleWorkerMessage(event.data);
    worker.onerror = (event): void => {
      event.preventDefault();
      this.#showReport("Track import failed", event.message || "The track parser stopped unexpectedly.", []);
      this.#pending.clear();
      worker.terminate();
      this.#worker = null;
      this.#options.onIdle();
    };
    this.#worker = worker;
    return worker;
  }

  #handleWorkerMessage(message: TrackParserMessage): void {
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "progress") {
      this.#options.onStatus(message.text, message.progress);
      return;
    }
    this.#pending.delete(message.requestId);
    if (message.type === "error") {
      this.#showReport("Track import failed", message.message, message.issues.map(
        (issue) => `Line ${issue.line.toLocaleString()}: ${issue.message}`,
      ));
      if (this.#pending.size === 0) this.#options.onIdle();
      return;
    }
    if (message.type === "inspection-complete") {
      if (this.#pending.size === 0) this.#options.onIdle();
      return;
    }
    if (message.type === "batch-complete") {
      if (pending.kind === "batch") {
        const exactResults = message.results.filter(({ report }) => report.matchKind === "exact");
        const aliasResults = message.results.filter(({ report }) => report.matchKind === "alias");
        for (const { candidate, report } of exactResults) {
          this.#addReport(
            report,
            { kind: "parse", axis: candidate.axis, sequence: candidate },
            pending.sourceId,
          );
        }
        if (aliasResults.length > 0) {
          this.#confirmBatchAliases(
            aliasResults,
            message.ambiguousRecords,
            message.ambiguousIdentifiers,
            pending.sourceId,
          );
        } else if (message.ambiguousRecords > 0) {
          this.#showReport(
            "Some annotation records were skipped",
            `${message.ambiguousRecords.toLocaleString()} records had aliases matching more than one loaded FASTA sequence.`,
            [
              "Ambiguous records were not duplicated.",
              `Identifiers: ${message.ambiguousIdentifiers.slice(0, 12).join(", ")}`,
            ],
          );
        }
      }
      if (this.#pending.size === 0) this.#options.onIdle();
      return;
    }
    if (pending.kind !== "parse") return;
    if (message.report.matchKind === "alias") {
      this.#confirmAlias(message.report, pending);
      if (this.#pending.size === 0) this.#options.onIdle();
      return;
    }
    this.#addReport(message.report, pending);
    if (this.#pending.size === 0) this.#options.onIdle();
  }

  #confirmBatchAliases(
    results: BatchTrackImportResult[],
    ambiguousRecords: number,
    ambiguousIdentifiers: string[],
    sourceId: number,
  ): void {
    this.#batchAliasConfirmations.push({ sourceId, results, ambiguousRecords, ambiguousIdentifiers });
    this.#showNextBatchAliasConfirmation();
  }

  #showNextBatchAliasConfirmation(): void {
    if (this.#batchAliasConfirmationActive || this.#options.dialog.open) return;
    const confirmation = this.#batchAliasConfirmations.shift();
    if (!confirmation) return;
    const { sourceId, results, ambiguousRecords, ambiguousIdentifiers } = confirmation;
    const details = results.slice(0, 12).map(({ candidate, report }) => (
      `${report.matchedIdentifier} → ${candidate.name} · ${report.validRecords.toLocaleString()} records`
    ));
    if (ambiguousRecords > 0) {
      details.push(
        `${ambiguousRecords.toLocaleString()} ambiguous records were skipped, not duplicated: ${ambiguousIdentifiers.slice(0, 8).join(", ")}`,
      );
    }
    this.#showReport(
      "Confirm sequence aliases",
      `${results.length.toLocaleString()} sequence associations use unique conservative chromosome aliases. Import them?`,
      details,
    );
    this.#batchAliasConfirmationActive = true;
    const confirm = this.#options.dialogConfirm;
    confirm.hidden = false;
    confirm.textContent = "Import alias matches";
    confirm.onclick = () => {
      confirm.hidden = true;
      confirm.onclick = null;
      this.#options.dialog.close();
      for (const { candidate, report } of results) {
        this.#addReport(
          report,
          { kind: "parse", axis: candidate.axis, sequence: candidate },
          sourceId,
        );
      }
    };
    this.#options.dialogClose.textContent = "Cancel";
  }

  #confirmAlias(report: TrackImportReport, pending: Extract<PendingImport, { kind: "parse" }>): void {
    const confirm = this.#options.dialogConfirm;
    this.#showReport(
      "Confirm sequence alias",
      `${report.matchedIdentifier} is not an exact match for ${report.sequenceName}. Import it as a conservative chromosome alias?`,
      [`Source file: ${report.fileName}`, `${report.validRecords.toLocaleString()} matching records`],
    );
    confirm.hidden = false;
    confirm.onclick = () => {
      confirm.hidden = true;
      confirm.onclick = null;
      this.#options.dialog.close();
      this.#addReport(report, pending);
    };
    this.#options.dialogClose.textContent = "Cancel";
  }

  #addReport(
    report: TrackImportReport,
    pending: Extract<PendingImport, { kind: "parse" }>,
    sourceId: number | null = null,
  ): void {
    for (const logicalTrack of report.tracks) this.#addTrack(logicalTrack, report, pending, sourceId);
  }

  #addTrack(
    logicalTrack: ImportedLogicalTrack,
    report: TrackImportReport,
    pending: Extract<PendingImport, { kind: "parse" }>,
    sourceId: number | null,
  ): void {
    const sequenceData: ImportedSequenceTrackData = {
      ...logicalTrack,
      sequenceIndex: pending.sequence.index,
      sequenceName: pending.sequence.name,
      format: report.format,
      prefixMaximumEnds: prefixMaximumEnds(logicalTrack.features),
    };
    const existing = sourceId === null ? undefined : this.#tracks.find(
      (track) => track.sourceId === sourceId && track.name === logicalTrack.name,
    );
    if (existing) {
      existing.sequenceData.set(sequenceData.sequenceIndex, sequenceData);
      this.#updateTrackSummary(existing);
      this.#updateEligibilityAndDraw();
      return;
    }
    const id = ++this.#nextTrackId;
    const row = document.createElement("div");
    row.className = "imported-track-control";
    const header = document.createElement("div");
    header.className = "imported-track-control-header";
    const name = document.createElement("strong");
    name.className = "imported-track-control-name";
    name.textContent = logicalTrack.name;
    name.title = report.fileName;
    const xInput = axisCheckbox("X", `imported-track-${id}-x`);
    const yInput = axisCheckbox("Y", `imported-track-${id}-y`);
    const bothInput = axisCheckbox("Both", `imported-track-${id}-both`);
    const laneControl = document.createElement("span");
    laneControl.className = "track-lane-control";
    const decrease = smallButton("−", "Use fewer feature rows");
    const laneValue = document.createElement("output");
    laneValue.value = "1";
    laneValue.textContent = "1";
    laneValue.setAttribute("aria-label", "Feature rows");
    const increase = smallButton("+", "Use more feature rows");
    laneControl.append(decrease, laneValue, increase);
    const remove = smallButton("Delete", `Delete ${logicalTrack.name} data`);
    remove.classList.add("track-delete-button");
    header.append(xInput.label, yInput.label, bothInput.label, laneControl, remove);
    const detail = document.createElement("small");
    row.append(name, header, detail);

    const xView = createTrackPanel(logicalTrack.name, "x", id);
    const yView = createTrackPanel(logicalTrack.name, "y", id);
    const track: ImportedTrackState = {
      id,
      sourceId,
      name: logicalTrack.name,
      fileName: report.fileName,
      format: report.format,
      sequenceData: new Map([[sequenceData.sequenceIndex, sequenceData]]),
      lanes: 1,
      enabled: sourceId === null
        ? { x: pending.axis === "x", y: pending.axis === "y" }
        : { x: true, y: true },
      inputs: { x: xInput.input, y: yInput.input },
      bothInput: bothInput.input,
      panels: { x: xView.panel, y: yView.panel },
      canvases: { x: xView.canvas, y: yView.canvas },
      hitTargets: { x: [], y: [] },
      row,
      detail,
    };
    xInput.input.checked = track.enabled.x;
    yInput.input.checked = track.enabled.y;
    this.#syncBothInput(track);
    this.#tracks.push(track);
    this.#options.list.append(row);
    this.#options.xStack.append(xView.panel);
    this.#options.yStack.append(yView.panel);
    this.#options.emptyMessage.hidden = true;
    for (const axis of ["x", "y"] as const) {
      const input = track.inputs[axis];
      input.addEventListener("change", () => {
        track.enabled[axis] = input.checked;
        this.#syncBothInput(track);
        this.#updateTrackVisibility(track, axis);
        this.#options.onLayoutChange();
      });
      const canvas = track.canvases[axis];
      canvas.addEventListener("pointermove", (event) => this.#showFeatureHover(track, axis, event));
      canvas.addEventListener("pointerleave", () => { this.#options.tooltip.hidden = true; });
      this.#resizeObserver.observe(track.panels[axis]);
      this.#makeDraggable(track.panels[axis], axis, () => {
        track.enabled[axis] = false;
        track.inputs[axis].checked = false;
        this.#syncBothInput(track);
        this.#updateTrackVisibility(track, axis);
      });
    }
    track.bothInput.addEventListener("change", () => {
      const checked = track.bothInput.checked;
      track.enabled.x = checked;
      track.enabled.y = checked;
      track.inputs.x.checked = checked;
      track.inputs.y.checked = checked;
      track.bothInput.indeterminate = false;
      this.#updateEligibilityAndDraw();
    });
    decrease.addEventListener("click", () => {
      track.lanes = Math.max(1, track.lanes - 1);
      laneValue.value = String(track.lanes);
      laneValue.textContent = String(track.lanes);
      this.#updateEligibilityAndDraw();
    });
    increase.addEventListener("click", () => {
      track.lanes = Math.min(MAX_LANES, track.lanes + 1);
      laneValue.value = String(track.lanes);
      laneValue.textContent = String(track.lanes);
      this.#updateEligibilityAndDraw();
    });
    remove.addEventListener("click", () => this.#deleteTrack(track));
    this.#updateTrackSummary(track);
    this.#updateEligibilityAndDraw();
  }

  #deleteTrack(track: ImportedTrackState): void {
    this.#resizeObserver.unobserve(track.panels.x);
    this.#resizeObserver.unobserve(track.panels.y);
    track.panels.x.remove();
    track.panels.y.remove();
    track.row.remove();
    const index = this.#tracks.indexOf(track);
    if (index >= 0) this.#tracks.splice(index, 1);
    this.#options.emptyMessage.hidden = this.#tracks.length > 0;
    this.#options.tooltip.hidden = true;
    this.#options.onLayoutChange();
    this.#options.onIdle();
  }

  #updateEligibilityAndDraw(): void {
    for (const track of this.#tracks) {
      this.#updateTrackVisibility(track, "x");
      this.#updateTrackVisibility(track, "y");
      this.#syncBothInput(track);
    }
    this.#options.onLayoutChange();
  }

  #updateTrackVisibility(track: ImportedTrackState, axis: FeatureTrackAxis): void {
    const metadata = this.#metadata;
    const eligible = metadata
      ? trackCollectionAxisEligible(track.sequenceData.keys(), axis, metadata.xIndex, metadata.yIndex)
      : false;
    track.inputs[axis].disabled = !eligible;
    track.inputs[axis].title = eligible ? "" : "This track has no features for the selected sequence";
    const visible = eligible && track.enabled[axis];
    track.panels[axis].hidden = !visible;
    track.panels[axis].dataset.trackSize = String(importedTrackSize(track.lanes));
    track.panels[axis].style.flexBasis = `${importedTrackSize(track.lanes)}px`;
    if (visible) this.#draw(track, axis);
    else clearCanvas(track.canvases[axis]);
  }

  #draw(track: ImportedTrackState, axis: FeatureTrackAxis): void {
    const metadata = this.#metadata;
    const view = this.#view;
    const canvas = track.canvases[axis];
    const context = canvas.getContext("2d");
    if (!metadata || !view || track.panels[axis].hidden || !context) return;
    const sequenceIndex = axis === "x" ? metadata.xIndex : metadata.yIndex;
    const sequenceData = track.sequenceData.get(sequenceIndex);
    if (!sequenceData) return;
    resizeCanvas(canvas);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    track.hitTargets[axis] = [];
    const coordinate = axis === "x" ? view.view.x : view.view.y;
    const matrixSpan = axis === "x" ? view.view.width : view.view.height;
    const length = axis === "x" ? metadata.xLength : metadata.yLength;
    const visibleStart = coordinate / metadata.baseResolution * metadata.domainLength;
    const visibleSpan = matrixSpan / metadata.baseResolution * metadata.domainLength;
    const visibleEnd = Math.min(length, visibleStart + visibleSpan);
    if (visibleSpan <= 0 || visibleEnd <= visibleStart) return;
    const hits: FeatureHit[] = [];
    const first = firstOverlappingIndex(sequenceData.prefixMaximumEnds, visibleStart);
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const laneSize = LANE_SIZE * dpr;
    for (let index = first; index < sequenceData.features.length; index += 1) {
      const feature = sequenceData.features[index];
      if (!feature) continue;
      if (feature.start >= visibleEnd) break;
      if (feature.end <= visibleStart) continue;
      const displayLane = Math.min(feature.lane, track.lanes - 1);
      context.strokeStyle = feature.color;
      context.fillStyle = feature.color;
      context.lineWidth = Math.max(1, dpr);
      const hit = axis === "x"
        ? drawHorizontalFeature(context, feature, displayLane, laneSize, visibleStart, visibleSpan, canvas.width, canvas.height, dpr)
        : drawVerticalFeature(context, feature, displayLane, laneSize, visibleStart, visibleSpan, canvas.width, canvas.height, dpr);
      if (hit) hits.push(hit);
    }
    track.hitTargets[axis] = hits;
  }

  #syncBothInput(track: ImportedTrackState): void {
    track.bothInput.checked = track.enabled.x && track.enabled.y;
    track.bothInput.indeterminate = track.enabled.x !== track.enabled.y;
    track.bothInput.disabled = track.inputs.x.disabled && track.inputs.y.disabled;
  }

  #updateTrackSummary(track: ImportedTrackState): void {
    const sequences = [...track.sequenceData.values()];
    const featureCount = sequences.reduce((total, sequence) => total + sequence.features.length, 0);
    const sequenceSummary = sequences.length === 1
      ? sequences[0]?.sequenceName ?? "1 matching sequence"
      : `${sequences.length.toLocaleString()} matching sequences`;
    track.detail.textContent = `${sequenceSummary} · ${track.format.toUpperCase()} · ${featureCount.toLocaleString()} displayed features`;
    track.row.querySelector<HTMLElement>(".imported-track-control-name")!.title = [
      track.fileName,
      ...sequences.map((sequence) => sequence.sequenceName),
    ].join(" · ");
  }

  #showFeatureHover(track: ImportedTrackState, axis: FeatureTrackAxis, event: PointerEvent): void {
    const canvas = track.canvases[axis];
    const bounds = canvas.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * canvas.width / Math.max(1, bounds.width);
    const y = (event.clientY - bounds.top) * canvas.height / Math.max(1, bounds.height);
    const hit = [...track.hitTargets[axis]].reverse().find(
      (candidate) => x >= candidate.left && x <= candidate.right && y >= candidate.top && y <= candidate.bottom,
    );
    if (!hit) {
      this.#options.tooltip.hidden = true;
      return;
    }
    const feature = hit.feature;
    this.#setTooltip([
      feature.name,
      `${feature.type} · ${formatInterval(feature.start, feature.end)}`,
      feature.strand === "." ? "strand —" : `strand ${feature.strand}`,
      ...feature.details,
    ], event);
  }

  #setTooltip(lines: string[], event: PointerEvent): void {
    const tooltip = this.#options.tooltip;
    tooltip.replaceChildren(...lines.map((line, index) => {
      const element = document.createElement(index === 0 ? "strong" : "span");
      element.textContent = line;
      return element;
    }));
    tooltip.hidden = false;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.min(window.innerWidth - width - 8, event.clientX + 14)}px`;
    tooltip.style.top = `${Math.min(window.innerHeight - height - 8, event.clientY + 14)}px`;
  }

  #makeDraggable(panel: HTMLElement, axis: FeatureTrackAxis, disable: () => void): void {
    let holdTimer = 0;
    let active = false;
    let pointerId = -1;
    let lastX = 0;
    let lastY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let dragWidth = 0;
    let dragHeight = 0;
    let ghost: HTMLElement | null = null;
    const stack = axis === "x" ? this.#options.xStack : this.#options.yStack;
    panel.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      const bounds = panel.getBoundingClientRect();
      offsetX = event.clientX - bounds.left;
      offsetY = event.clientY - bounds.top;
      dragWidth = bounds.width;
      dragHeight = bounds.height;
      holdTimer = window.setTimeout(() => {
        if (pointerId < 0) return;
        active = true;
        panel.classList.add("is-track-drag-source");
        document.body.classList.add("is-track-pointer-dragging");
        ghost = createDragGhost(panel, bounds);
        updateDragGhost(ghost, lastX, lastY, offsetX, offsetY, false);
      }, 180);
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", cancel, true);
    });

    const move = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      lastX = event.clientX;
      lastY = event.clientY;
      if (!active) return;
      event.preventDefault();
      const bounds = stack.getBoundingClientRect();
      const inside = pointInRect(lastX, lastY, bounds);
      if (ghost) updateDragGhost(ghost, lastX, lastY, offsetX, offsetY, !inside);
      if (!inside) {
        return;
      }
      const dragCenter = axis === "x"
        ? lastY - offsetY + dragHeight / 2
        : lastX - offsetX + dragWidth / 2;
      reorderPanelAtCoordinate(panel, stack, axis, dragCenter);
    };

    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      complete(false);
    };

    const cancel = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      complete(true);
    };

    const complete = (cancelled: boolean): void => {
      window.clearTimeout(holdTimer);
      if (active) {
        const bounds = stack.getBoundingClientRect();
        const shouldDisable = !cancelled && !pointInRect(lastX, lastY, bounds);
        panel.classList.remove("is-track-drag-source");
        ghost?.remove();
        ghost = null;
        if (shouldDisable) disable();
        this.#options.onLayoutChange();
      }
      active = false;
      pointerId = -1;
      document.body.classList.remove("is-track-pointer-dragging");
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
    };
  }

  #showReport(title: string, summary: string, details: string[]): void {
    this.#options.dialogConfirm.hidden = true;
    this.#options.dialogConfirm.textContent = "Import track";
    this.#options.dialogConfirm.onclick = null;
    this.#options.dialogSecondary.hidden = true;
    this.#options.dialogSecondary.textContent = "";
    this.#options.dialogSecondary.onclick = null;
    this.#options.dialogClose.textContent = "Close";
    this.#options.dialogTitle.textContent = title;
    this.#options.dialogSummary.textContent = summary;
    this.#options.dialogDetails.replaceChildren(...details.map((detail) => {
      const item = document.createElement("li");
      item.textContent = detail;
      return item;
    }));
    if (!this.#options.dialog.open) this.#options.dialog.showModal();
  }
}

function axisCheckbox(labelText: string, id: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = labelText;
  const input = document.createElement("input");
  input.id = id;
  input.type = "checkbox";
  label.append(text, input);
  return { label, input };
}

function smallButton(text: string, ariaLabel: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", ariaLabel);
  return button;
}

function createTrackPanel(name: string, axis: FeatureTrackAxis, id: number): { panel: HTMLElement; canvas: HTMLCanvasElement } {
  const panel = document.createElement("div");
  panel.id = `imported-track-${id}-${axis}-panel`;
  panel.className = `feature-track-panel feature-track-panel-${axis} imported-feature-track-panel`;
  panel.hidden = true;
  const label = document.createElement("span");
  label.className = "feature-track-name";
  label.textContent = name;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", `${axis.toUpperCase()}-axis ${name} feature track`);
  panel.append(label, canvas);
  return { panel, canvas };
}

function prefixMaximumEnds(features: ImportedFeature[]): number[] {
  const result = new Array<number>(features.length);
  let maximum = 0;
  for (let index = 0; index < features.length; index += 1) {
    maximum = Math.max(maximum, features[index]?.end ?? 0);
    result[index] = maximum;
  }
  return result;
}

function firstOverlappingIndex(prefixEnds: number[], start: number): number {
  let low = 0;
  let high = prefixEnds.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((prefixEnds[middle] ?? 0) > start) high = middle;
    else low = middle + 1;
  }
  return low;
}

function drawHorizontalFeature(
  context: CanvasRenderingContext2D,
  feature: ImportedFeature,
  lane: number,
  laneSize: number,
  visibleStart: number,
  visibleSpan: number,
  width: number,
  height: number,
  dpr: number,
): FeatureHit | null {
  const start = (feature.start - visibleStart) / visibleSpan * width;
  const end = (feature.end - visibleStart) / visibleSpan * width;
  const y = height - (lane + 0.5) * laneSize;
  if (end < 0 || start > width) return null;
  context.beginPath();
  context.moveTo(start, y);
  context.lineTo(end, y);
  context.stroke();
  const thin = Math.max(3 * dpr, laneSize * 0.48);
  const thick = Math.max(5 * dpr, laneSize * 0.72);
  for (let index = 0; index + 1 < feature.blocks.length; index += 2) {
    const genomicBlockStart = feature.blocks[index] ?? feature.start;
    const genomicBlockEnd = feature.blocks[index + 1] ?? feature.end;
    const blockStart = (genomicBlockStart - visibleStart) / visibleSpan * width;
    const blockEnd = (genomicBlockEnd - visibleStart) / visibleSpan * width;
    context.fillRect(blockStart, y - thin / 2, Math.max(dpr, blockEnd - blockStart), thin);
    if (feature.thickStart !== undefined && feature.thickEnd !== undefined) {
      const codingStart = Math.max(genomicBlockStart, feature.thickStart);
      const codingEnd = Math.min(genomicBlockEnd, feature.thickEnd);
      if (codingEnd > codingStart) {
        const codingPixelStart = (codingStart - visibleStart) / visibleSpan * width;
        const codingPixelEnd = (codingEnd - visibleStart) / visibleSpan * width;
        context.fillRect(codingPixelStart, y - thick / 2, Math.max(dpr, codingPixelEnd - codingPixelStart), thick);
      }
    }
  }
  drawHorizontalStrand(context, feature.strand, start, end, y, dpr);
  return { left: Math.max(0, start), top: y - laneSize / 2, right: Math.min(width, end), bottom: y + laneSize / 2, feature };
}

function drawVerticalFeature(
  context: CanvasRenderingContext2D,
  feature: ImportedFeature,
  lane: number,
  laneSize: number,
  visibleStart: number,
  visibleSpan: number,
  width: number,
  height: number,
  dpr: number,
): FeatureHit | null {
  const start = height - (feature.start - visibleStart) / visibleSpan * height;
  const end = height - (feature.end - visibleStart) / visibleSpan * height;
  const x = width - (lane + 0.5) * laneSize;
  if (start < 0 && end < 0 || start > height && end > height) return null;
  context.beginPath();
  context.moveTo(x, start);
  context.lineTo(x, end);
  context.stroke();
  const thin = Math.max(3 * dpr, laneSize * 0.48);
  const thick = Math.max(5 * dpr, laneSize * 0.72);
  for (let index = 0; index + 1 < feature.blocks.length; index += 2) {
    const genomicBlockStart = feature.blocks[index] ?? feature.start;
    const genomicBlockEnd = feature.blocks[index + 1] ?? feature.end;
    const blockStart = height - (genomicBlockStart - visibleStart) / visibleSpan * height;
    const blockEnd = height - (genomicBlockEnd - visibleStart) / visibleSpan * height;
    context.fillRect(x - thin / 2, blockEnd, thin, Math.max(dpr, blockStart - blockEnd));
    if (feature.thickStart !== undefined && feature.thickEnd !== undefined) {
      const codingStart = Math.max(genomicBlockStart, feature.thickStart);
      const codingEnd = Math.min(genomicBlockEnd, feature.thickEnd);
      if (codingEnd > codingStart) {
        const codingPixelStart = height - (codingStart - visibleStart) / visibleSpan * height;
        const codingPixelEnd = height - (codingEnd - visibleStart) / visibleSpan * height;
        context.fillRect(x - thick / 2, codingPixelEnd, thick, Math.max(dpr, codingPixelStart - codingPixelEnd));
      }
    }
  }
  drawVerticalStrand(context, feature.strand, start, end, x, dpr);
  return { left: x - laneSize / 2, top: Math.max(0, end), right: x + laneSize / 2, bottom: Math.min(height, start), feature };
}

function drawHorizontalStrand(
  context: CanvasRenderingContext2D,
  strand: ImportedFeature["strand"],
  start: number,
  end: number,
  y: number,
  dpr: number,
): void {
  if (strand === "." || end - start < 18 * dpr) return;
  const direction = strand === "+" ? 1 : -1;
  for (let x = start + 12 * dpr; x < end - 5 * dpr; x += 22 * dpr) {
    context.beginPath();
    context.moveTo(x - direction * 3 * dpr, y - 2 * dpr);
    context.lineTo(x, y);
    context.lineTo(x - direction * 3 * dpr, y + 2 * dpr);
    context.stroke();
  }
}

function drawVerticalStrand(
  context: CanvasRenderingContext2D,
  strand: ImportedFeature["strand"],
  start: number,
  end: number,
  x: number,
  dpr: number,
): void {
  if (strand === "." || start - end < 18 * dpr) return;
  const direction = strand === "+" ? -1 : 1;
  for (let y = end + 12 * dpr; y < start - 5 * dpr; y += 22 * dpr) {
    context.beginPath();
    context.moveTo(x - 2 * dpr, y - direction * 3 * dpr);
    context.lineTo(x, y);
    context.lineTo(x + 2 * dpr, y - direction * 3 * dpr);
    context.stroke();
  }
}

function resizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const bounds = canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width * dpr));
  const height = Math.max(1, Math.round(bounds.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function clearCanvas(canvas: HTMLCanvasElement): void {
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

function importedTrackSize(lanes: number): number {
  return Math.max(MIN_IMPORTED_TRACK_SIZE, lanes * LANE_SIZE + 7);
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Selects an adjacent visual slot only after the dragged track crosses its midpoint. */
export function midpointSwapDirection(
  coordinate: number,
  precedingMidpoint: number | null,
  followingMidpoint: number | null,
): -1 | 0 | 1 {
  if (precedingMidpoint !== null && coordinate < precedingMidpoint) return -1;
  if (followingMidpoint !== null && coordinate > followingMidpoint) return 1;
  return 0;
}

function reorderPanelAtCoordinate(
  panel: HTMLElement,
  stack: HTMLElement,
  axis: FeatureTrackAxis,
  coordinate: number,
): void {
  for (let pass = 0; pass < stack.childElementCount; pass += 1) {
    const panels = [...stack.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement
        && !element.hidden
        && element.classList.contains("feature-track-panel"))
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          element,
          midpoint: axis === "x"
            ? bounds.top + bounds.height / 2
            : bounds.left + bounds.width / 2,
        };
      })
      .sort((left, right) => left.midpoint - right.midpoint);
    const current = panels.findIndex((candidate) => candidate.element === panel);
    if (current < 0) return;
    const direction = midpointSwapDirection(
      coordinate,
      panels[current - 1]?.midpoint ?? null,
      panels[current + 1]?.midpoint ?? null,
    );
    if (direction === 0) return;
    const target = panels[current + direction]?.element;
    if (!target) return;
    swapElements(panel, target);
  }
}

function swapElements(first: HTMLElement, second: HTMLElement): void {
  const marker = document.createComment("track-order");
  first.replaceWith(marker);
  second.replaceWith(first);
  marker.replaceWith(second);
}

function createDragGhost(panel: HTMLElement, bounds: DOMRect): HTMLElement {
  const ghost = panel.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.hidden = false;
  ghost.classList.remove("is-track-drag-source");
  ghost.classList.add("track-drag-ghost");
  ghost.style.width = `${bounds.width}px`;
  ghost.style.height = `${bounds.height}px`;
  ghost.style.flexBasis = "auto";
  const sourceCanvases = panel.querySelectorAll("canvas");
  const ghostCanvases = ghost.querySelectorAll("canvas");
  for (let index = 0; index < sourceCanvases.length; index += 1) {
    const source = sourceCanvases[index];
    const copy = ghostCanvases[index];
    if (!source || !copy) continue;
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext("2d")?.drawImage(source, 0, 0);
  }
  document.body.append(ghost);
  return ghost;
}

function updateDragGhost(
  ghost: HTMLElement,
  clientX: number,
  clientY: number,
  offsetX: number,
  offsetY: number,
  removing: boolean,
): void {
  ghost.style.left = `${clientX - offsetX}px`;
  ghost.style.top = `${clientY - offsetY}px`;
  ghost.classList.toggle("is-removing", removing);
}

function closestDropTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-track-drop-axis]")
    : null;
}

function hasFiles(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}
