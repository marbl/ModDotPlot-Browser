import "./styles.css";
import { AxisOverlay } from "./axes";
import { selectDetailResolution, selectTiles } from "./detail";
import { DnaLoader } from "./dna-loader";
import { formatBases, formatBytes, formatInterval } from "./format";
import {
  FeatureTrackOverlay,
  featureTrackRequests,
  type FeatureTrackMetadata,
  type FeatureTrackSelection,
} from "./feature-track";
import {
  DEFAULT_HEATMAP_PALETTE,
  HEATMAP_PALETTES,
  addIdentitiesToHistogram,
  heatmapGradient,
  normalizeHeatmapRange,
  type HeatmapPalette,
  type HeatmapRange,
} from "./heatmap";
import { ImportedTrackManager } from "./imported-track";
import { DotplotRenderer, type HoverDatum, type ViewChange } from "./renderer";
import {
  decideResourceAdmission,
  totalResourceBytes,
  type ResourceClass,
  type ResourceUsage,
} from "./resource-plan";
import type {
  ComparisonParameters,
  MainToWorkerMessage,
  SequenceMetadata,
  WorkerToMainMessage,
} from "./protocol";

const landing = element<HTMLElement>("landing");
const workspace = element<HTMLElement>("workspace");
const dropZone = element<HTMLButtonElement>("drop-zone");
const landingVersion = element<HTMLElement>("landing-version");
const controlVersion = element<HTMLElement>("control-version");
const fileInput = element<HTMLInputElement>("file-input");
const clearButton = element<HTMLButtonElement>("clear-button");
const xSelect = element<HTMLSelectElement>("x-sequence");
const ySelect = element<HTMLSelectElement>("y-sequence");
const resolutionSelect = element<HTMLSelectElement>("resolution");
const previewRegisterSelect = element<HTMLSelectElement>("preview-register-count");
const detailedRegisterSelect = element<HTMLSelectElement>("detailed-register-count");
const kmerInput = element<HTMLInputElement>("kmer-length");
const plotDetailNote = element<HTMLElement>("plot-detail-note");
const sketchRetentionNote = element<HTMLElement>("sketch-retention-note");
const scientificProvenance = element<HTMLOutputElement>("scientific-provenance");
const resetViewButton = element<HTMLButtonElement>("reset-view");
const status = element<HTMLElement>("status");
const retryEngineButton = element<HTMLButtonElement>("retry-engine");
const memoryUsage = element<HTMLElement>("memory-usage");
const hoverCard = element<HTMLElement>("hover-card");
const plotSummary = element<HTMLElement>("plot-summary");
const plotFrame = element<HTMLElement>("plot-frame");
const plotLoading = element<HTMLElement>("plot-loading");
const dnaLoader = new DnaLoader();
plotLoading.append(dnaLoader.canvas);
const versionLabel = `v${__APP_VERSION__}`;
landingVersion.textContent = versionLabel;
controlVersion.textContent = versionLabel;
const plotColumn = element<HTMLElement>("plot-column");
const canvas = element<HTMLCanvasElement>("plot-canvas");
const xAxisCanvas = element<HTMLCanvasElement>("x-axis-overlay");
const yAxisCanvas = element<HTMLCanvasElement>("y-axis-overlay");
const xSequenceLabel = element<HTMLElement>("x-sequence-label");
const ySequenceLabel = element<HTMLElement>("y-sequence-label");
const featureTrackInputs = {
  gc: {
    x: element<HTMLInputElement>("gc-track-x"),
    y: element<HTMLInputElement>("gc-track-y"),
  },
  cpg: {
    x: element<HTMLInputElement>("cpg-track-x"),
    y: element<HTMLInputElement>("cpg-track-y"),
  },
};
const featureTrackBothInputs = {
  gc: element<HTMLInputElement>("gc-track-both"),
  cpg: element<HTMLInputElement>("cpg-track-both"),
};
const featureTrackPanels = {
  gc: {
    x: element<HTMLElement>("gc-track-x-panel"),
    y: element<HTMLElement>("gc-track-y-panel"),
  },
  cpg: {
    x: element<HTMLElement>("cpg-track-x-panel"),
    y: element<HTMLElement>("cpg-track-y-panel"),
  },
};
const xFeatureTrackStack = element<HTMLElement>("x-feature-track-stack");
const yFeatureTrackStack = element<HTMLElement>("y-feature-track-stack");
const xAxisPanel = element<HTMLElement>("x-axis-panel");
const yAxisPanel = element<HTMLElement>("y-axis-panel");
const importedTrackList = element<HTMLElement>("imported-track-list");
const importedTrackEmpty = element<HTMLElement>("imported-track-empty");
const addTrackButton = element<HTMLButtonElement>("add-track");
const trackFileInput = element<HTMLInputElement>("track-file-input");
const trackImportDialog = element<HTMLDialogElement>("track-import-dialog");
const trackImportTitle = element<HTMLElement>("track-import-title");
const trackImportSummary = element<HTMLElement>("track-import-summary");
const trackImportDetails = element<HTMLElement>("track-import-details");
const trackImportConfirm = element<HTMLButtonElement>("track-import-confirm");
const trackImportSecondary = element<HTMLButtonElement>("track-import-secondary");
const trackImportClose = element<HTMLButtonElement>("track-import-close");
const sequenceLoadDialog = element<HTMLDialogElement>("sequence-load-dialog");
const sequenceLoadSummary = element<HTMLElement>("sequence-load-summary");
const sequenceLoadDetails = element<HTMLElement>("sequence-load-details");
const sequenceLoadClose = element<HTMLButtonElement>("sequence-load-close");
const trackHoverCard = element<HTMLElement>("track-hover-card");
const xGcCanvas = element<HTMLCanvasElement>("gc-track-x-canvas");
const yGcCanvas = element<HTMLCanvasElement>("gc-track-y-canvas");
const xCpgCanvas = element<HTMLCanvasElement>("cpg-track-x-canvas");
const yCpgCanvas = element<HTMLCanvasElement>("cpg-track-y-canvas");
const progressOverlay = element<HTMLElement>("compute-progress");
const progressRing = element<SVGCircleElement>("progress-ring");
const progressValue = element<HTMLElement>("progress-value");
const histogramCanvas = element<HTMLCanvasElement>("identity-histogram");
const heatmapPaletteSelect = element<HTMLSelectElement>("heatmap-palette");
const backgroundButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-background-mode]")];
const heatmapGradientElement = element<HTMLElement>("heatmap-gradient");
const heatmapInputs = {
  minimum: element<HTMLInputElement>("heatmap-min"),
  midpoint: element<HTMLInputElement>("heatmap-mid"),
  maximum: element<HTMLInputElement>("heatmap-max"),
};
const heatmapOutputs = {
  minimum: element<HTMLOutputElement>("heatmap-min-value"),
  midpoint: element<HTMLOutputElement>("heatmap-mid-value"),
  maximum: element<HTMLOutputElement>("heatmap-max-value"),
};

const renderer = createRenderer(canvas);
const axes = new AxisOverlay(xAxisCanvas, yAxisCanvas);
const featureTracks = new FeatureTrackOverlay([
  { kind: "gc", axis: "x", canvas: xGcCanvas, maximum: 1 },
  { kind: "gc", axis: "y", canvas: yGcCanvas, maximum: 1 },
  { kind: "cpg", axis: "x", canvas: xCpgCanvas, maximum: 2 },
  { kind: "cpg", axis: "y", canvas: yCpgCanvas, maximum: 2 },
]);
const importedTracks = new ImportedTrackManager({
  xStack: xFeatureTrackStack,
  yStack: yFeatureTrackStack,
  xDropTargets: [xAxisPanel, xFeatureTrackStack],
  yDropTargets: [yAxisPanel, yFeatureTrackStack],
  list: importedTrackList,
  emptyMessage: importedTrackEmpty,
  addButton: addTrackButton,
  input: trackFileInput,
  dialog: trackImportDialog,
  dialogTitle: trackImportTitle,
  dialogSummary: trackImportSummary,
  dialogDetails: trackImportDetails,
  dialogConfirm: trackImportConfirm,
  dialogSecondary: trackImportSecondary,
  dialogClose: trackImportClose,
  tooltip: trackHoverCard,
  getSequence: (axis) => sequences.find(
    (sequence) => sequence.index === Number(axis === "x" ? xSelect.value : ySelect.value),
  ) ?? null,
  onLayoutChange: updateFeatureTrackLayout,
  onStatus: showTrackImportStatus,
  onIdle: restoreStatusAfterTrackImport,
});
for (const kind of ["gc", "cpg"] as const) {
  for (const axis of ["x", "y"] as const) {
    importedTracks.registerComputedPanel(featureTrackPanels[kind][axis], axis, () => {
      featureTrackInputs[kind][axis].checked = false;
      updateFeatureTrackSelection();
    });
  }
}
featureTracks.onHover((hover, event) => importedTracks.showQuantitativeHover(hover, event));
let worker: Worker;
let sequences: SequenceMetadata[] = [];
let lastFiles: File[] = [];
let recoveryFiles: File[] | null = null;
let workerFailed = false;
let generation = 0;
let prepareTimer = 0;
let detailTimer = 0;
let featureTrackTimer = 0;
let tileRequestId = 0;
let featureTrackRequestId = 0;
let comparisonReady = false;
let activeParameters: ComparisonParameters | null = null;
let activeFeatureTrackMetadata: FeatureTrackMetadata | null = null;
let activeDomainLength = 1;
let pendingView: ViewChange | null = null;
let currentMeasurement: "sketch" | "kmer" = "sketch";
let overviewReadyText = "Ready";
let plotStatusText = "Ready";
let featureTrackBusy = false;
let sequenceLoadPending = false;
let wasmBytes = 0;
let heatmapRange: HeatmapRange = { minimum: 85, midpoint: 92, maximum: 100 };
let histogramBins = new Uint32Array(101);
const histogramTiles = new Set<string>();

function handleWorkerMessage(event: MessageEvent<WorkerToMainMessage>): void {
  const message = event.data;
  switch (message.type) {
    case "ready":
      if (recoveryFiles) {
        const files = recoveryFiles;
        recoveryFiles = null;
        loadFiles(files, false);
      } else if (!status.classList.contains("error")) {
        plotStatusText = "Ready";
        status.textContent = "Ready";
        hideProgress();
      }
      break;
    case "status":
      if (status.classList.contains("error")) break;
      plotStatusText = message.text;
      status.textContent = message.text;
      if (message.busy) showProgress(message.text, message.progress);
      else hideProgress();
      break;
    case "sequences":
      if (message.generation !== generation) return;
      sequences = message.sequences;
      if (sequences.length === 0) {
        rejectSequenceLoad("No sequence records were found.");
        return;
      }
      sequenceLoadPending = false;
      populateSelectors();
      queueComparison(0);
      break;
    case "comparison-ready":
      if (message.generation !== generation) return;
      comparisonReady = true;
      updateScientificProvenance(message.configurations, message.parameters.k);
      plotStatusText = "Drawing quick overview";
      status.textContent = "Drawing quick overview";
      if (pendingView && requestedResolution(pendingView) > message.parameters.resolution) {
        cancelAndQueueVisibleDetail(0);
      }
      queueFeatureTracks(180);
      break;
    case "preview-complete":
      if (message.generation !== generation || message.requestId !== tileRequestId) return;
      void renderer.present().then(() => {
        if (message.generation !== generation || message.requestId !== tileRequestId) return;
        post({
          type: "preview-presented",
          generation: message.generation,
          requestId: message.requestId,
        });
      });
      break;
    case "tile":
      if (message.generation !== generation) return;
      renderer.addTile(message);
      setPlotLoading(false);
      collectHistogram(message);
      updateMemory();
      break;
    case "complete":
      if (message.generation !== generation) return;
      wasmBytes = message.estimatedBytes;
      overviewReadyText = `Ready · ${(message.elapsedMs / 1000).toFixed(1)} s`;
      plotStatusText = overviewReadyText;
      if (currentMeasurement === "sketch" && !status.classList.contains("error")) {
        status.textContent = overviewReadyText;
      }
      setPlotLoading(false);
      hideProgress();
      updateMemory();
      break;
    case "feature-track-status":
      if (message.generation !== generation || message.requestId !== featureTrackRequestId) return;
      featureTrackBusy = true;
      if (!status.classList.contains("error")) {
        status.textContent = message.text;
        showProgress(message.text, message.progress);
      }
      break;
    case "feature-tracks":
      if (message.generation !== generation || message.requestId !== featureTrackRequestId) return;
      for (const track of message.tracks) {
        if (featureTrackInputs[track.kind][track.axis].checked) featureTracks.setData(track);
      }
      featureTrackBusy = false;
      wasmBytes = message.estimatedBytes;
      if (!status.classList.contains("error")) status.textContent = plotStatusText;
      hideProgress();
      updateMemory();
      break;
    case "memory":
      wasmBytes = message.estimatedBytes;
      updateMemory();
      break;
    case "error":
      featureTrackBusy = false;
      if (sequenceLoadPending) rejectSequenceLoad(message.message);
      else {
        setPlotLoading(false);
        showError(message.message);
      }
      break;
  }
}

startWorker();
sequenceLoadClose.addEventListener("click", () => sequenceLoadDialog.close());

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const files = [...(fileInput.files ?? [])];
  // Release the chooser immediately so a second selection, including the same file,
  // always produces a fresh change event while an earlier load is being cancelled.
  fileInput.value = "";
  if (files.length) loadFiles(files);
});
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) loadFiles(files);
});

for (const control of [
  xSelect,
  ySelect,
  resolutionSelect,
  previewRegisterSelect,
  detailedRegisterSelect,
  kmerInput,
]) {
  control.addEventListener("change", () => {
    normalizeRegisterControls(control);
    updateParameterNotes();
    queueComparison(150);
  });
}
for (const [name, input] of Object.entries(heatmapInputs) as Array<[keyof HeatmapRange, HTMLInputElement]>) {
  input.addEventListener("input", () => updateHeatmap(name));
}
heatmapPaletteSelect.addEventListener("change", updateHeatmapAppearance);
for (const button of backgroundButtons) {
  button.addEventListener("click", () => {
    for (const peer of backgroundButtons) peer.setAttribute("aria-pressed", String(peer === button));
    updateHeatmapAppearance();
  });
}
for (const kind of ["gc", "cpg"] as const) {
  featureTrackInputs[kind].x.addEventListener("change", () => updateFeatureTrackSelection());
  featureTrackInputs[kind].y.addEventListener("change", () => updateFeatureTrackSelection());
  featureTrackBothInputs[kind].addEventListener("change", () => {
    const checked = featureTrackBothInputs[kind].checked;
    featureTrackInputs[kind].x.checked = checked;
    featureTrackInputs[kind].y.checked = checked;
    featureTrackBothInputs[kind].indeterminate = false;
    updateFeatureTrackSelection();
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-color-mode]")) {
  button.addEventListener("click", () => {
    const mode = button.dataset.colorMode;
    if (mode !== "similarity" && mode !== "direction") return;
    renderer.setColorMode(mode);
    for (const peer of document.querySelectorAll<HTMLButtonElement>("[data-color-mode]")) {
      peer.setAttribute("aria-pressed", String(peer === button));
    }
  });
}
resetViewButton.addEventListener("click", () => renderer.resetView());
clearButton.addEventListener("click", clearSession);
retryEngineButton.addEventListener("click", restartEngine);
renderer.onHover(showHover);
renderer.onViewChange((change) => {
  pendingView = change;
  axes.setView(change);
  if (activeFeatureTrackMetadata) featureTracks.setView(activeFeatureTrackMetadata, change);
  if (activeFeatureTrackMetadata) importedTracks.setView(activeFeatureTrackMetadata, change);
  if (comparisonReady) {
    queueFeatureTracks(40);
    cancelAndQueueVisibleDetail(240);
  }
});
renderer.onTileEvict((tile) => {
  post({ type: "evict-tiles", generation, tiles: [tile] });
});
updateHeatmap("midpoint");
drawHistogram();
updateParameterNotes();

function loadFiles(files: File[], remember = true): void {
  const annotations = files.filter((file) => isAnnotationFileName(file.name));
  if (annotations.length > 0) {
    showSequenceLoadDialog(
      `${fileList(annotations)} ${annotations.length === 1 ? "is an annotation file" : "are annotation files"}, not FASTA sequence input.`,
      [
        "Load one or more FASTA or FASTA.gz files first.",
        "After the dotplot opens, add BED, GFF, or GTF annotations from Feature tracks or by dropping them on an axis.",
      ],
    );
    return;
  }
  if (remember) lastFiles = [...files];
  window.clearTimeout(prepareTimer);
  window.clearTimeout(detailTimer);
  window.clearTimeout(featureTrackTimer);
  generation += 1;
  tileRequestId += 1;
  featureTrackRequestId += 1;
  sequences = [];
  comparisonReady = false;
  activeParameters = null;
  activeFeatureTrackMetadata = null;
  pendingView = null;
  featureTrackBusy = false;
  sequenceLoadPending = true;
  xSelect.replaceChildren();
  ySelect.replaceChildren();
  xSequenceLabel.textContent = "";
  ySequenceLabel.textContent = "";
  renderer.clearTiles();
  featureTracks.clear();
  importedTracks.clear();
  setPlotLoading(true);
  landing.hidden = true;
  workspace.hidden = false;
  clearButton.hidden = false;
  retryEngineButton.hidden = true;
  status.classList.remove("error");
  plotStatusText = "Reading sequence";
  status.textContent = "Reading sequence";
  showProgress("Reading sequence");
  post({ type: "load", generation, files });
}

function populateSelectors(): void {
  const options = sequences.map((sequence) => {
    const option = document.createElement("option");
    option.value = String(sequence.index);
    option.textContent = `${sequence.name} · ${formatBases(sequence.length)}`;
    return option;
  });
  xSelect.replaceChildren(...options.map((option) => option.cloneNode(true)));
  ySelect.replaceChildren(...options);
  xSelect.value = String(sequences[0]?.index ?? 0);
  ySelect.value = String(sequences[0]?.index ?? 0);
  updateParameterNotes();
}

function queueComparison(delay: number): void {
  window.clearTimeout(prepareTimer);
  prepareTimer = window.setTimeout(prepareComparison, delay);
}

function prepareComparison(): void {
  const xIndex = Number(xSelect.value);
  const yIndex = Number(ySelect.value);
  const x = sequences.find((sequence) => sequence.index === xIndex);
  const y = sequences.find((sequence) => sequence.index === yIndex);
  if (!x || !y) return;
  const preserveViewport = activeParameters?.xIndex === xIndex && activeParameters.yIndex === yIndex;
  activeDomainLength = Math.max(x.length, y.length);
  const parameters: ComparisonParameters = {
    xIndex,
    yIndex,
    resolution: Math.min(Number(resolutionSelect.value), Math.max(1, activeDomainLength)),
    previewRegisterCount: Number(previewRegisterSelect.value),
    detailedRegisterCount: Number(detailedRegisterSelect.value),
    sparseCorrection: false,
    k: Number(kmerInput.value),
  };
  generation += 1;
  tileRequestId += 1;
  featureTrackRequestId += 1;
  comparisonReady = false;
  featureTrackBusy = false;
  currentMeasurement = "sketch";
  overviewReadyText = "Ready";
  activeParameters = parameters;
  activeFeatureTrackMetadata = {
    baseResolution: parameters.resolution,
    domainLength: activeDomainLength,
    xIndex,
    yIndex,
    xLength: x.length,
    yLength: y.length,
  };
  importedTracks.updateSequenceContext(activeFeatureTrackMetadata);
  pendingView = null;
  histogramBins = new Uint32Array(101);
  histogramTiles.clear();
  if (!preserveViewport) featureTracks.clear();
  drawHistogram();
  setPlotLoading(true);
  renderer.setComparison({
    resolution: parameters.resolution,
    domainLength: activeDomainLength,
    xLength: x.length,
    yLength: y.length,
  }, preserveViewport);
  axes.setMetadata({
    baseResolution: parameters.resolution,
    domainLength: activeDomainLength,
    xName: x.name,
    yName: y.name,
    xLength: x.length,
    yLength: y.length,
  });
  xSequenceLabel.textContent = x.name;
  xSequenceLabel.title = `${x.name} · ${formatBases(x.length)}`;
  ySequenceLabel.textContent = y.name;
  ySequenceLabel.title = `${y.name} · ${formatBases(y.length)}`;
  status.classList.remove("error");
  plotStatusText = "Building overview signatures";
  status.textContent = "Building overview signatures";
  showProgress("Building overview signatures", 0);
  post({ type: "prepare", generation, requestId: tileRequestId, parameters });
  updateParameterNotes();
}

function queueVisibleDetail(delay: number): void {
  window.clearTimeout(detailTimer);
  if (!comparisonReady || !activeParameters || !pendingView) return;
  detailTimer = window.setTimeout(requestVisibleDetail, delay);
}

function cancelAndQueueVisibleDetail(delay: number): void {
  if (!comparisonReady) return;
  tileRequestId += 1;
  post({ type: "cancel-tiles", generation, requestId: tileRequestId });
  queueVisibleDetail(delay);
}

function requestVisibleDetail(): void {
  const parameters = activeParameters;
  const change = pendingView;
  if (!comparisonReady || !parameters || !change) return;
  if (featureTrackBusy) {
    queueVisibleDetail(120);
    return;
  }
  const resolution = requestedResolution(change);
  const exactKmerLevel = resolution === Math.floor(activeDomainLength);
  currentMeasurement = exactKmerLevel ? "kmer" : "sketch";
  renderer.setActiveResolution(resolution);
  const tiles = selectTiles(resolution, parameters.resolution, change.view);
  const computeLabel = exactKmerLevel
    ? "Drawing exact k-mers"
    : resolution === parameters.resolution
      ? "Restoring overview"
      : "Drawing quick detail";
  plotStatusText = `${computeLabel} · 0%`;
  status.textContent = plotStatusText;
  showProgress(computeLabel, 0);
  post({
    type: "request-tiles",
    generation,
    requestId: tileRequestId,
    resolution,
    mode: exactKmerLevel ? "kmer" : "sketch",
    tiles,
  });
}

function requestedResolution(change: ViewChange): number {
  if (!activeParameters) return 1;
  return selectDetailResolution(
    activeParameters.resolution,
    activeDomainLength,
    change.view,
    change.pixelWidth,
    change.pixelHeight,
  );
}

function updateFeatureTrackSelection(): void {
  for (const kind of ["gc", "cpg"] as const) syncBothTrackInput(kind);
  const selection = currentFeatureTrackSelection();
  for (const axis of ["x", "y"] as const) {
    for (const kind of ["gc", "cpg"] as const) {
      const selected = selection[kind][axis];
      featureTrackPanels[kind][axis].hidden = !selected;
      if (!selected) featureTracks.clear(kind, axis);
    }
  }
  updateFeatureTrackLayout();
  if (activeFeatureTrackMetadata && pendingView) {
    featureTracks.setView(activeFeatureTrackMetadata, pendingView);
  }
  queueFeatureTracks(0);
  updateMemory();
}

function updateFeatureTrackLayout(): void {
  const total = (stack: HTMLElement): number => [...stack.children].reduce((sum, child) => {
    if (!(child instanceof HTMLElement) || child.hidden) return sum;
    return sum + Number(child.dataset.trackSize ?? 28);
  }, 0);
  plotColumn.style.setProperty("--x-track-height", `${total(xFeatureTrackStack)}px`);
  plotColumn.style.setProperty("--y-track-width", `${total(yFeatureTrackStack)}px`);
}

function currentFeatureTrackSelection(): FeatureTrackSelection {
  return {
    gc: { x: featureTrackInputs.gc.x.checked, y: featureTrackInputs.gc.y.checked },
    cpg: { x: featureTrackInputs.cpg.x.checked, y: featureTrackInputs.cpg.y.checked },
  };
}

function syncBothTrackInput(kind: "gc" | "cpg"): void {
  const x = featureTrackInputs[kind].x.checked;
  const y = featureTrackInputs[kind].y.checked;
  featureTrackBothInputs[kind].checked = x && y;
  featureTrackBothInputs[kind].indeterminate = x !== y;
}

function queueFeatureTracks(delay: number): void {
  window.clearTimeout(featureTrackTimer);
  featureTrackRequestId += 1;
  post({ type: "cancel-feature-tracks", generation, requestId: featureTrackRequestId });
  if (featureTrackBusy) {
    featureTrackBusy = false;
    if (!status.classList.contains("error")) status.textContent = plotStatusText;
    hideProgress();
  }
  const selection = currentFeatureTrackSelection();
  const anySelected = Object.values(selection).some((axes) => axes.x || axes.y);
  if (
    !comparisonReady
    || !activeFeatureTrackMetadata
    || !pendingView
    || !anySelected
  ) return;
  featureTrackTimer = window.setTimeout(requestFeatureTracks, delay);
}

function requestFeatureTracks(): void {
  if (!comparisonReady || !activeFeatureTrackMetadata || !pendingView) return;
  const tracks = featureTrackRequests(
    activeFeatureTrackMetadata,
    pendingView,
    currentFeatureTrackSelection(),
  );
  if (tracks.length === 0) return;
  featureTrackRequestId += 1;
  post({ type: "request-feature-tracks", generation, requestId: featureTrackRequestId, tracks });
}

function showHover(datum: HoverDatum | null, event: PointerEvent): void {
  if (!datum) {
    hoverCard.hidden = true;
    plotSummary.textContent = "No plot position selected.";
    return;
  }
  const identity = datum.identity === null ? "idy —" : `idy ${datum.identity.toFixed(2)}%`;
  hoverCard.innerHTML = `
    <strong>${identity}</strong>
    <span>x ${formatInterval(datum.genomicXStart, datum.genomicXEnd)}</span>
    <span>y ${formatInterval(datum.genomicYStart, datum.genomicYEnd)}</span>
  `;
  plotSummary.textContent = `${identity}; x ${formatInterval(datum.genomicXStart, datum.genomicXEnd)}; y ${formatInterval(datum.genomicYStart, datum.genomicYEnd)}.`;
  const frame = hoverCard.parentElement?.getBoundingClientRect();
  if (frame) {
    hoverCard.style.left = `${Math.min(frame.width - 180, Math.max(8, event.clientX - frame.left + 14))}px`;
    hoverCard.style.top = `${Math.min(frame.height - 78, Math.max(8, event.clientY - frame.top + 14))}px`;
  }
  hoverCard.hidden = false;
}

function updateHeatmap(changed: keyof HeatmapRange): void {
  heatmapRange = normalizeHeatmapRange(
    {
      minimum: Number(heatmapInputs.minimum.value),
      midpoint: Number(heatmapInputs.midpoint.value),
      maximum: Number(heatmapInputs.maximum.value),
    },
    changed,
  );
  for (const name of Object.keys(heatmapInputs) as Array<keyof HeatmapRange>) {
    heatmapInputs[name].value = String(heatmapRange[name]);
    heatmapOutputs[name].value = `${heatmapRange[name].toFixed(1)}%`;
  }
  renderer.setHeatmapRange(heatmapRange.minimum, heatmapRange.midpoint, heatmapRange.maximum);
  updateHeatmapAppearance();
}

function updateHeatmapAppearance(): void {
  const palette = selectedHeatmapPalette();
  const darkBackground = backgroundButtons.some(
    (button) => button.dataset.backgroundMode === "black" && button.getAttribute("aria-pressed") === "true",
  );
  renderer.setHeatmapPalette(palette);
  renderer.setDarkBackground(darkBackground);
  plotFrame.classList.toggle("dark-background", darkBackground);
  heatmapGradientElement.style.background = heatmapGradient(
    palette,
    heatmapRange,
    darkBackground,
  );
}

function selectedHeatmapPalette(): HeatmapPalette {
  const selected = heatmapPaletteSelect.value;
  return selected in HEATMAP_PALETTES
    ? selected as HeatmapPalette
    : DEFAULT_HEATMAP_PALETTE;
}

function collectHistogram(message: Extract<WorkerToMainMessage, { type: "tile" }>): void {
  if (!activeParameters || message.resolution !== activeParameters.resolution) return;
  const finalQuality = "refined";
  if (message.quality !== finalQuality) return;
  const key = `${message.x}:${message.y}`;
  if (histogramTiles.has(key)) return;
  histogramTiles.add(key);
  addIdentitiesToHistogram(histogramBins, message.identity);
  drawHistogram();
}

function drawHistogram(): void {
  const context = histogramCanvas.getContext("2d");
  if (!context) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.max(1, Math.round(histogramCanvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(28 * dpr));
  if (histogramCanvas.width !== width || histogramCanvas.height !== height) {
    histogramCanvas.width = width;
    histogramCanvas.height = height;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cssWidth = width / dpr;
  const cssHeight = height / dpr;
  context.clearRect(0, 0, cssWidth, cssHeight);
  const firstBin = 80;
  const visibleBins = histogramBins.subarray(firstBin);
  const maximum = Math.max(1, ...visibleBins);
  context.fillStyle = "rgba(58, 87, 104, 0.34)";
  for (let index = firstBin; index < histogramBins.length; index += 1) {
    const value = histogramBins[index] ?? 0;
    const barHeight = Math.log1p(value) / Math.log1p(maximum) * (cssHeight - 2);
    const x = (index - firstBin) / visibleBins.length * cssWidth;
    const barWidth = Math.max(1, cssWidth / visibleBins.length);
    context.fillRect(x, cssHeight - barHeight, barWidth, barHeight);
  }
}

function updateParameterNotes(): void {
  const resolution = Number(resolutionSelect.value);
  plotDetailNote.textContent = `${(resolution * resolution).toLocaleString()} similarity cells before zoom refinement`;
  const x = sequences.find((sequence) => sequence.index === Number(xSelect.value));
  const y = sequences.find((sequence) => sequence.index === Number(ySelect.value));
  if (!x || !y) return;
  const domain = Math.max(x.length, y.length);
  const starts = Math.max(1, domain / resolution - Number(kmerInput.value) + 1);
  const previewRegisters = Number(previewRegisterSelect.value);
  const registers = Number(detailedRegisterSelect.value);
  const occupied = registers * (1 - Math.exp(-starts / registers));
  const fraction = Math.min(1, occupied / starts) * 100;
  const shownFraction = fraction < 0.01 ? "<0.01" : fraction < 1 ? fraction.toFixed(2) : fraction.toFixed(1);
  sketchRetentionNote.textContent = `${previewRegisters.toLocaleString()} quick → ${registers.toLocaleString()} detailed registers; ~${Math.round(occupied).toLocaleString()} occupied winners/interval (≤~${shownFraction}% of starts)`;
}

function normalizeRegisterControls(changed: Element): void {
  const preview = Number(previewRegisterSelect.value);
  const detailed = Number(detailedRegisterSelect.value);
  if (preview <= detailed) return;
  if (changed === previewRegisterSelect) detailedRegisterSelect.value = previewRegisterSelect.value;
  else previewRegisterSelect.value = detailedRegisterSelect.value;
}

function showProgress(_label: string, progress?: number): void {
  progressOverlay.hidden = false;
  if (progress === undefined) {
    progressOverlay.classList.add("is-indeterminate");
    progressValue.textContent = "";
    progressRing.style.strokeDashoffset = "";
  } else {
    progressOverlay.classList.remove("is-indeterminate");
    const bounded = Math.max(0, Math.min(1, progress));
    progressValue.textContent = `${Math.round(bounded * 100)}%`;
    progressRing.style.strokeDashoffset = String(50.265 * (1 - bounded));
  }
}

function hideProgress(): void {
  progressOverlay.hidden = true;
  progressOverlay.classList.remove("is-indeterminate");
}

function setPlotLoading(loading: boolean): void {
  plotLoading.hidden = !loading;
  if (loading) dnaLoader.start();
  else dnaLoader.stop();
}

function updateMemory(): void {
  const rendererBytes = renderer.estimatedByteBreakdown();
  const usage: ResourceUsage = {
    wasm: wasmBytes,
    jsTiles: rendererBytes.jsTiles,
    gpuTextures: rendererBytes.gpuTextures,
    annotations: importedTracks.estimatedBytes(),
    featureTracks: featureTracks.estimatedBytes(),
    transientPublication: 0,
  };
  const total = totalResourceBytes(usage);
  memoryUsage.textContent = total > 0 ? `Memory ~${formatBytes(total)}` : "Memory —";
  const resourceClasses: ResourceClass[] = [
    "wasm",
    "jsTiles",
    "gpuTextures",
    "annotations",
    "featureTracks",
    "transientPublication",
  ];
  const constrained = resourceClasses
    .map((resource) => decideResourceAdmission(usage, resource, 0))
    .find((decision) => decision.action !== "admit");
  memoryUsage.dataset.resourceAction = constrained?.action ?? "admit";
  memoryUsage.title = constrained
    ? `${constrained.reason} ${constrained.fallback ?? ""}`.trim()
    : "Current Wasm, JavaScript tile, GPU texture, annotation, and transient usage fits the declared plan.";
}

function clearSession(): void {
  window.clearTimeout(prepareTimer);
  window.clearTimeout(detailTimer);
  window.clearTimeout(featureTrackTimer);
  generation += 1;
  tileRequestId += 1;
  featureTrackRequestId += 1;
  sequences = [];
  lastFiles = [];
  recoveryFiles = null;
  comparisonReady = false;
  currentMeasurement = "sketch";
  activeParameters = null;
  activeFeatureTrackMetadata = null;
  pendingView = null;
  featureTrackBusy = false;
  sequenceLoadPending = false;
  wasmBytes = 0;
  histogramBins = new Uint32Array(101);
  histogramTiles.clear();
  renderer.clearTiles();
  featureTracks.clear();
  importedTracks.clear();
  setPlotLoading(false);
  if (workerFailed) startWorker();
  post({ type: "clear", generation });
  fileInput.value = "";
  workspace.hidden = true;
  landing.hidden = false;
  clearButton.hidden = true;
  hoverCard.hidden = true;
  retryEngineButton.hidden = true;
  hideProgress();
  updateMemory();
}

function showError(message: string): void {
  featureTrackBusy = false;
  status.textContent = message;
  status.classList.add("error");
  hideProgress();
}

function rejectSequenceLoad(message: string): void {
  const attemptedFiles = [...lastFiles];
  clearSession();
  const guidance = /(?:memory|budget)/i.test(message)
    ? "The selected multi-FASTA contains more packed sequence than one browser session can retain. Load a chromosome, haplotype, or smaller record subset."
    : "Check that every sequence record begins with a > header line, then try again.";
  showSequenceLoadDialog(
    `${fileList(attemptedFiles)} could not be parsed as FASTA. No sequence data was loaded.`,
    [message, guidance],
  );
}

function showSequenceLoadDialog(summary: string, details: string[]): void {
  sequenceLoadSummary.textContent = summary;
  sequenceLoadDetails.replaceChildren(...details.map((detail) => {
    const item = document.createElement("li");
    item.textContent = detail;
    return item;
  }));
  if (!sequenceLoadDialog.open) sequenceLoadDialog.showModal();
}

function isAnnotationFileName(name: string): boolean {
  return /\.(?:bed|gff3?|gff2|gtf)(?:\.txt)?(?:\.(?:gz|bgz|bgzf))?$/i.test(name);
}

function fileList(files: File[]): string {
  if (files.length === 0) return "The selected input";
  const shown = files.slice(0, 3).map((file) => file.name).join(", ");
  return files.length > 3 ? `${shown}, and ${files.length - 3} more files` : shown;
}

function showTrackImportStatus(text: string, progress?: number): void {
  if (status.classList.contains("error")) return;
  status.textContent = text;
  showProgress(text, progress);
}

function restoreStatusAfterTrackImport(): void {
  if (status.classList.contains("error")) return;
  status.textContent = plotStatusText;
  hideProgress();
  updateMemory();
}

function startWorker(): void {
  workerFailed = false;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (event): void => {
    event.preventDefault();
    handleWorkerFailure(event.message || "The compute worker stopped unexpectedly.");
  };
  worker.onmessageerror = (): void => {
    handleWorkerFailure("The compute worker returned an unreadable message.");
  };
}

function handleWorkerFailure(message: string): void {
  if (workerFailed) return;
  workerFailed = true;
  comparisonReady = false;
  featureTrackBusy = false;
  worker.terminate();
  setPlotLoading(false);
  showError(`${message} Restart the compute engine to reload the selected FASTA files.`);
  retryEngineButton.hidden = false;
}

function restartEngine(): void {
  if (!workerFailed) worker.terminate();
  recoveryFiles = lastFiles.length > 0 ? [...lastFiles] : null;
  comparisonReady = false;
  activeParameters = null;
  activeFeatureTrackMetadata = null;
  featureTrackRequestId += 1;
  featureTrackBusy = false;
  renderer.clearTiles();
  featureTracks.clear();
  setPlotLoading(true);
  wasmBytes = 0;
  updateMemory();
  retryEngineButton.hidden = true;
  status.classList.remove("error");
  plotStatusText = "Restarting compute engine";
  status.textContent = "Restarting compute engine";
  showProgress("Restarting compute engine");
  startWorker();
}

function post(message: MainToWorkerMessage): void {
  worker.postMessage(message);
}

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing required element #${id}`);
  return found as unknown as T;
}

function createRenderer(target: HTMLCanvasElement): DotplotRenderer {
  try {
    if (!("WebAssembly" in globalThis) || !("Worker" in globalThis) || !("ResizeObserver" in globalThis) || !("DecompressionStream" in globalThis)) {
      throw new Error("This browser is missing WebAssembly, Web Workers, ResizeObserver, or gzip decompression support.");
    }
    return new DotplotRenderer(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    document.body.replaceChildren(Object.assign(document.createElement("p"), {
      className: "fatal-error",
      textContent: `moddotplot-rs cannot start: ${message}`,
    }));
    throw error;
  }
}

function updateScientificProvenance(
  configurations: import("./protocol").ScientificConfigMetadata[],
  k: number,
): void {
  if (configurations.length === 0) {
    scientificProvenance.textContent = `Exact canonical ${k}-mer mode · software ${__APP_VERSION__}`;
    scientificProvenance.title = "No sketch estimator is used at this terminal resolution.";
    return;
  }
  const tiers = [...configurations].sort((left, right) => left.registerCount - right.registerCount);
  const selected = tiers[tiers.length - 1]!;
  const registerText = tiers.map((tier) => tier.registerCount.toLocaleString()).join(" → ");
  scientificProvenance.textContent = `${selected.hashAlgorithm} · verified OPH · ${registerText} registers · HLL p${selected.hllPrecision} · config ${selected.digest.slice(0, 8)}`;
  scientificProvenance.title = [
    `software=${__APP_VERSION__}`,
    `config-version=${selected.version}`,
    `digest=${selected.digest}`,
    `k=${selected.k}`,
    `hash=${selected.hashAlgorithm}`,
    `seed=${selected.hashSeed}`,
    `estimator=${selected.estimator}`,
    `registers=${registerText}`,
    `comparison-bits=${selected.bBits}`,
    `verification-bits=${selected.verificationBits}`,
    `hll-precision=${selected.hllPrecision}`,
    `sparse-cap=${selected.sparseCoreCap}`,
    `ani-floor=${selected.aniFloor}`,
    `match-probability=${selected.minimumDetectionProbability}`,
    `identity-scale=${selected.identityScale}`,
    `missing=${selected.missingIdentity}`,
  ].join("\n");
}
