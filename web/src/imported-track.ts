import { formatInterval } from "./format";
import {
  trackAxisEligible,
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

interface ImportedTrackState extends ImportedLogicalTrack {
  id: number;
  sequenceIndex: number;
  sequenceName: string;
  lanes: number;
  enabled: Record<FeatureTrackAxis, boolean>;
  inputs: Record<FeatureTrackAxis, HTMLInputElement>;
  panels: Record<FeatureTrackAxis, HTMLElement>;
  canvases: Record<FeatureTrackAxis, HTMLCanvasElement>;
  prefixMaximumEnds: number[];
  hitTargets: Record<FeatureTrackAxis, FeatureHit[]>;
  row: HTMLElement;
}

interface FeatureHit {
  left: number;
  top: number;
  right: number;
  bottom: number;
  feature: ImportedFeature;
}

type PendingImport =
  | { kind: "parse"; axis: FeatureTrackAxis; sequence: SequenceMetadata }
  | { kind: "inspect"; file: File; candidates: TrackSequenceCandidate[] };

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
  #metadata: FeatureTrackMetadata | null = null;
  #view: ViewChange | null = null;

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
    return this.#tracks.reduce((total, track) => total + track.features.reduce(
      (featureTotal, feature) => featureTotal + 160 + feature.blocks.length * 8 + feature.details.join("").length * 2,
      0,
    ), 0);
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
    this.#pending.clear();
    this.#options.emptyMessage.hidden = false;
    this.#options.tooltip.hidden = true;
    this.#options.onLayoutChange();
  }

  #wireInputs(): void {
    this.#options.addButton.addEventListener("click", () => this.#options.input.click());
    this.#options.input.addEventListener("change", () => {
      const files = [...(this.#options.input.files ?? [])];
      this.#options.input.value = "";
      if (files.length > 0) this.#autoImportFiles(files);
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
    const x = this.#options.getSequence("x");
    const y = this.#options.getSequence("y");
    if (!x || !y) {
      this.#showReport("Track import unavailable", "Load a FASTA sequence before importing a feature track.", []);
      return;
    }
    for (const file of files) {
      if (x.index === y.index) {
        this.#startParse(file, "x", x);
        continue;
      }
      const requestId = ++this.#nextRequestId;
      const candidates: TrackSequenceCandidate[] = [
        { axis: "x", index: x.index, name: x.name, length: x.length },
        { axis: "y", index: y.index, name: y.name, length: y.length },
      ];
      this.#pending.set(requestId, { kind: "inspect", file, candidates });
      const request: TrackParserRequest = { type: "inspect", requestId, file, candidates };
      this.#parserWorker().postMessage(request);
    }
    this.#options.onStatus(`Matching ${files[0]?.name ?? "feature track"}`);
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

  #startParse(file: File, axis: FeatureTrackAxis, sequence: SequenceMetadata): void {
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
      if (pending.kind === "inspect") this.#finishInspection(pending, message.identifiers, message.matches);
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

  #finishInspection(
    pending: Extract<PendingImport, { kind: "inspect" }>,
    identifiers: string[],
    matches: Array<TrackSequenceCandidate & { identifier: string; matchKind: "exact" | "alias" }>,
  ): void {
    const exactMatches = matches.filter((match) => match.matchKind === "exact");
    const preferred = exactMatches.length > 0 ? exactMatches : matches;
    if (preferred.length === 1) {
      const match = preferred[0];
      if (match) this.#startParse(pending.file, match.axis, match);
      return;
    }
    if (preferred.length === 0) {
      this.#showReport(
        "Track import failed",
        "No feature sequence identifier matched either displayed sequence.",
        identifiers.length > 0 ? [`Found: ${identifiers.slice(0, 12).join(", ")}`] : [],
      );
      return;
    }
    this.#chooseAxis(pending.file, preferred);
  }

  #chooseAxis(file: File, matches: TrackSequenceCandidate[]): void {
    const x = matches.find((match) => match.axis === "x");
    const y = matches.find((match) => match.axis === "y");
    if (!x || !y) return;
    this.#showReport(
      "Choose a track axis",
      `${file.name} contains records matching both displayed sequences.`,
      ["Choose which sequence this imported track should be associated with."],
    );
    this.#options.dialogConfirm.hidden = false;
    this.#options.dialogConfirm.textContent = `X · ${x.name}`;
    this.#options.dialogConfirm.onclick = () => {
      this.#options.dialog.close();
      this.#startParse(file, "x", x);
    };
    this.#options.dialogSecondary.hidden = false;
    this.#options.dialogSecondary.textContent = `Y · ${y.name}`;
    this.#options.dialogSecondary.onclick = () => {
      this.#options.dialog.close();
      this.#startParse(file, "y", y);
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

  #addReport(report: TrackImportReport, pending: Extract<PendingImport, { kind: "parse" }>): void {
    for (const logicalTrack of report.tracks) this.#addTrack(logicalTrack, report, pending);
  }

  #addTrack(
    logicalTrack: ImportedLogicalTrack,
    report: TrackImportReport,
    pending: Extract<PendingImport, { kind: "parse" }>,
  ): void {
    const id = ++this.#nextTrackId;
    const row = document.createElement("div");
    row.className = "imported-track-control";
    const header = document.createElement("div");
    header.className = "imported-track-control-header";
    const name = document.createElement("strong");
    name.className = "imported-track-control-name";
    name.textContent = logicalTrack.name;
    name.title = `${report.fileName} · ${pending.sequence.name}`;
    const xInput = axisCheckbox("X", `imported-track-${id}-x`);
    const yInput = axisCheckbox("Y", `imported-track-${id}-y`);
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
    header.append(xInput.label, yInput.label, laneControl, remove);
    const detail = document.createElement("small");
    detail.textContent = `${pending.sequence.name} · ${report.format.toUpperCase()} · ${logicalTrack.features.length.toLocaleString()} displayed features`;
    row.append(name, header, detail);

    const xView = createTrackPanel(logicalTrack.name, "x", id);
    const yView = createTrackPanel(logicalTrack.name, "y", id);
    const track: ImportedTrackState = {
      ...logicalTrack,
      id,
      sequenceIndex: pending.sequence.index,
      sequenceName: pending.sequence.name,
      lanes: 1,
      enabled: { x: pending.axis === "x", y: pending.axis === "y" },
      inputs: { x: xInput.input, y: yInput.input },
      panels: { x: xView.panel, y: yView.panel },
      canvases: { x: xView.canvas, y: yView.canvas },
      prefixMaximumEnds: prefixMaximumEnds(logicalTrack.features),
      hitTargets: { x: [], y: [] },
      row,
    };
    xInput.input.checked = track.enabled.x;
    yInput.input.checked = track.enabled.y;
    this.#tracks.push(track);
    this.#options.list.append(row);
    this.#options.xStack.append(xView.panel);
    this.#options.yStack.append(yView.panel);
    this.#options.emptyMessage.hidden = true;
    for (const axis of ["x", "y"] as const) {
      const input = track.inputs[axis];
      input.addEventListener("change", () => {
        track.enabled[axis] = input.checked;
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
        this.#updateTrackVisibility(track, axis);
      });
    }
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
    }
    this.#options.onLayoutChange();
  }

  #updateTrackVisibility(track: ImportedTrackState, axis: FeatureTrackAxis): void {
    const metadata = this.#metadata;
    const eligible = metadata
      ? trackAxisEligible(track.sequenceIndex, axis, metadata.xIndex, metadata.yIndex)
      : false;
    track.inputs[axis].disabled = !eligible;
    track.inputs[axis].title = eligible ? "" : `This track is associated with ${track.sequenceName}`;
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
    const first = firstOverlappingIndex(track.prefixMaximumEnds, visibleStart);
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const laneSize = LANE_SIZE * dpr;
    for (let index = first; index < track.features.length; index += 1) {
      const feature = track.features[index];
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
      const inReorderRegion = pointInTrackReorderRegion(
        lastX,
        lastY,
        bounds,
        axis,
        dragWidth,
        dragHeight,
      );
      if (ghost) updateDragGhost(ghost, lastX, lastY, offsetX, offsetY, !inReorderRegion);
      if (!inReorderRegion) {
        return;
      }
      const dragStart = axis === "x" ? lastY - offsetY : lastX - offsetX;
      const dragEnd = dragStart + (axis === "x" ? dragHeight : dragWidth);
      reorderPanelAtInterval(panel, stack, axis, dragStart, dragEnd);
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
        const shouldDisable = !cancelled && !pointInTrackReorderRegion(
          lastX,
          lastY,
          bounds,
          axis,
          dragWidth,
          dragHeight,
        );
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

function pointInTrackReorderRegion(
  x: number,
  y: number,
  rect: DOMRect,
  axis: FeatureTrackAxis,
  trackWidth: number,
  trackHeight: number,
): boolean {
  return axis === "x"
    ? x >= rect.left && x <= rect.right
      && y >= rect.top - trackHeight && y <= rect.bottom + trackHeight
    : y >= rect.top && y <= rect.bottom
      && x >= rect.left - trackWidth && x <= rect.right + trackWidth;
}

/** Selects an adjacent slot only after the dragged track completely clears it. */
export function fullTrackSwapDirection(
  dragStart: number,
  dragEnd: number,
  precedingStart: number | null,
  followingEnd: number | null,
): -1 | 0 | 1 {
  if (precedingStart !== null && dragEnd <= precedingStart) return -1;
  if (followingEnd !== null && dragStart >= followingEnd) return 1;
  return 0;
}

function reorderPanelAtInterval(
  panel: HTMLElement,
  stack: HTMLElement,
  axis: FeatureTrackAxis,
  dragStart: number,
  dragEnd: number,
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
          start: axis === "x" ? bounds.top : bounds.left,
          end: axis === "x" ? bounds.bottom : bounds.right,
        };
      })
      .sort((left, right) => left.start - right.start);
    const current = panels.findIndex((candidate) => candidate.element === panel);
    if (current < 0) return;
    const direction = fullTrackSwapDirection(
      dragStart,
      dragEnd,
      panels[current - 1]?.start ?? null,
      panels[current + 1]?.end ?? null,
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
