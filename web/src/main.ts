import "./styles.css";
import { AxisOverlay } from "./axes";
import { CursorGuideController } from "./cursor-guides";
import {
  DEFAULT_PALETTE_REVERSED,
  PALETTE_GROUPS,
  isPaletteId,
  paletteColors,
  paletteColorCounts,
  paletteDefaultColorCount,
} from "./palettes";
import { selectDetailResolution, selectTiles } from "./detail";
import { DnaLoader } from "./dna-loader";
import {
  loadBundledArabidopsisAnnotation,
  loadBundledArabidopsisExample,
  type ArabidopsisExampleStartup,
} from "./example-loader";
import { ExportController } from "./export-controller";
import { exportBaseName, type ExportProvenance, type NumericExportContext } from "./export";
import {
  DEFAULT_EXACT_KMER_GEOMETRY,
  DEFAULT_EXACT_VISUALIZATION,
  exactConfigDigest,
  exactGeometryLabel,
  exactIdentityLabel,
  exactModeBannerText,
  type ExactKmerGeometry,
  type ExactVisualizationMode,
} from "./exact-mode";
import { formatBases, formatBytes, formatInterval, formatPlotWindowSize } from "./format";
import { GridPairRenderer } from "./grid-renderer";
import {
  FeatureTrackOverlay,
  featureTrackRequests,
  type FeatureTrackMetadata,
  type FeatureTrackSelection,
} from "./feature-track";
import {
  DEFAULT_HEATMAP_COLOR_COUNT,
  DEFAULT_HEATMAP_PALETTE,
  addIdentitiesToHistogram,
  heatmapGradient,
  normalizeHeatmapRange,
  type HeatmapPalette,
  type HeatmapRange,
} from "./heatmap";
import { ImportedTrackManager } from "./imported-track";
import {
  normalizeGridSelections,
  planGridComparisons,
  validGridSizes,
  type GridComparison,
  type PlotMode,
} from "./plot-mode";
import {
  normalizePairwiseSelection,
  type PairwiseAxis,
  type PairwiseSelection,
} from "./pairwise-selection";
import {
  DotplotRenderer,
  type HoverDatum,
  type ViewChange,
} from "./renderer";
import { REFINEMENT_POLICY_VERSION } from "./refinement";
import { sequenceAxisLabel } from "./sequence-metadata";
import {
  decideResourceAdmission,
  totalResourceBytes,
  type ResourceClass,
  type ResourceUsage,
} from "./resource-plan";
import type {
  ComparisonParameters,
  MainToWorkerMessage,
  ScientificConfigMetadata,
  SequenceMetadata,
  WorkerToMainMessage,
} from "./protocol";

const landing = element<HTMLElement>("landing");
const workspace = element<HTMLElement>("workspace");
const dropZone = element<HTMLButtonElement>("drop-zone");
const annotationDropZone = element<HTMLButtonElement>("annotation-drop-zone");
const exploreButton = element<HTMLButtonElement>("explore-button");
const exampleButton = element<HTMLButtonElement>("example-button");
const exampleProgress = element<HTMLElement>("example-progress");
const exampleProgressLabel = element<HTMLElement>("example-progress-label");
const exampleProgressValue = element<HTMLElement>("example-progress-value");
const exampleProgressBar = element<HTMLProgressElement>("example-progress-bar");
const fastaSelection = element<HTMLElement>("fasta-selection");
const annotationSelection = element<HTMLElement>("annotation-selection");
const landingVersion = element<HTMLElement>("landing-version");
const controlVersion = element<HTMLElement>("control-version");
const fileInput = element<HTMLInputElement>("file-input");
const annotationFileInput = element<HTMLInputElement>("annotation-file-input");
const clearButton = element<HTMLButtonElement>("clear-button");
const selfSelect = element<HTMLSelectElement>("self-sequence");
const xSelect = element<HTMLSelectElement>("x-sequence");
const ySelect = element<HTMLSelectElement>("y-sequence");
const plotModeTabs = element<HTMLElement>("plot-mode-tabs");
const plotModeButtons = [...plotModeTabs.querySelectorAll<HTMLButtonElement>("[data-plot-mode]")];
const plotModePanels = {
  self: element<HTMLElement>("self-selection-panel"),
  pairwise: element<HTMLElement>("pairwise-selection-panel"),
  grid: element<HTMLElement>("grid-selection-panel"),
};
const gridSizeSelect = element<HTMLSelectElement>("grid-size");
const gridSequenceSelectors = element<HTMLElement>("grid-sequence-selectors");
const gridSelectionNote = element<HTMLElement>("grid-selection-note");
const resolutionSelect = element<HTMLSelectElement>("resolution");
const previewRegisterSelect = element<HTMLSelectElement>("preview-register-count");
const detailedRegisterSelect = element<HTMLSelectElement>("detailed-register-count");
const kmerInput = element<HTMLInputElement>("kmer-length");
const plotResolutionNote = element<HTMLElement>("plot-resolution-note");
const plotWindowSize = element<HTMLOutputElement>("plot-window-size");
const plotWindowSizeNote = element<HTMLElement>("plot-window-size-note");
const sketchRetentionNote = element<HTMLElement>("sketch-retention-note");
const scientificProvenance = element<HTMLOutputElement>("scientific-provenance");
const resetViewButton = element<HTMLButtonElement>("reset-view");
const exportDataButton = element<HTMLButtonElement>("export-data");
const exportImageButton = element<HTMLButtonElement>("export-image");
const status = element<HTMLElement>("status");
const retryEngineButton = element<HTMLButtonElement>("retry-engine");
const memoryUsage = element<HTMLElement>("memory-usage");
const hoverCard = element<HTMLElement>("hover-card");
const plotSummary = element<HTMLElement>("plot-summary");
const plotFrame = element<HTMLElement>("plot-frame");
const plotShell = element<HTMLElement>("plot-shell");
const plotGridView = element<HTMLElement>("plot-grid-view");
const plotGrid = element<HTMLElement>("plot-grid");
const plotLoading = element<HTMLElement>("plot-loading");
const backToGridButton = element<HTMLButtonElement>("back-to-grid");
const exactModeControls = element<HTMLElement>("exact-mode-controls");
const exactViewButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-exact-view]")];
const exactModeBanner = element<HTMLElement>("exact-mode-banner");
const exactBaseLegend = element<HTMLElement>("exact-base-legend");
const dnaLoader = new DnaLoader();
plotLoading.append(dnaLoader.canvas);
const versionLabel = `v${__APP_VERSION__}`;
landingVersion.textContent = versionLabel;
controlVersion.textContent = versionLabel;
const plotColumn = element<HTMLElement>("plot-column");
const canvas = element<HTMLCanvasElement>("plot-canvas");
const cursorGuideOverlay = element<HTMLElement>("cursor-guides");
const cursorGuidesEnabled = element<HTMLInputElement>("cursor-guides-enabled");
const cursorGuideGeometry = element<HTMLSelectElement>("cursor-guide-geometry");
const cursorGuideStyle = element<HTMLSelectElement>("cursor-guide-style");
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
const featureTrackControls = element<HTMLElement>("feature-track-controls");
const plotActions = element<HTMLElement>("plot-actions");
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
const exportProgressDialog = element<HTMLDialogElement>("export-progress-dialog");
const exportProgressMessage = element<HTMLElement>("export-progress-message");
const exportProgressBar = element<HTMLProgressElement>("export-progress-bar");
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
const heatmapColorCountInput = element<HTMLInputElement>("heatmap-color-count");
const paletteFlipButton = element<HTMLButtonElement>("palette-flip");
const paletteSwatches = element<HTMLElement>("palette-swatches");
const paletteColorEditor = element<HTMLDialogElement>("palette-color-editor");
const paletteColorEditorTitle = element<HTMLElement>("palette-color-editor-title");
const paletteColorWheel = element<HTMLInputElement>("palette-color-wheel");
const paletteColorHex = element<HTMLInputElement>("palette-color-hex");
const paletteColorMessage = element<HTMLElement>("palette-color-message");
const paletteColorReset = element<HTMLButtonElement>("palette-color-reset");
const paletteColorDone = element<HTMLButtonElement>("palette-color-done");
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
const cursorGuideController = new CursorGuideController({
  frame: plotFrame,
  canvas,
  overlay: cursorGuideOverlay,
  controls: {
    enabled: cursorGuidesEnabled,
    geometry: cursorGuideGeometry,
    style: cursorGuideStyle,
  },
});
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
  getSequence: (axis) => {
    const selection = selectedSingleComparison();
    if (!selection) return null;
    const index = axis === "x" ? selection.xIndex : selection.yIndex;
    return sequences.find((sequence) => sequence.index === index) ?? null;
  },
  getSequences: () => sequences,
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
let plotMode: PlotMode = "self";
type GridAxis = "x" | "y";
let gridSelectedIndices: number[] = [];
let gridDraggedSequenceIndex: number | null = null;
let gridDraggedAxis: GridAxis | null = null;
let gridPrepareTimer = 0;
let gridAppearanceTimer = 0;
let lastFiles: File[] = [];
let stagedFastaFiles: File[] = [];
let stagedAnnotationFiles: File[] = [];
let pendingLandingAnnotations: File[] = [];
let launchValidationPending = false;
let launchReady = false;
let launchExampleWhenReady = false;
let exampleLoadController: AbortController | null = null;
let exampleAnnotationController: AbortController | null = null;
let activeBundledExample: ArabidopsisExampleStartup | null = null;
let recoveryBundledExample: ArabidopsisExampleStartup | null = null;
let gridReturnAvailable = false;
let gridReturnCell: HTMLButtonElement | null = null;
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
let activeConfigurations: ScientificConfigMetadata[] = [];
let activeFeatureTrackMetadata: FeatureTrackMetadata | null = null;
let activeDomainLength = 1;
let pendingView: ViewChange | null = null;
let currentMeasurement: "sketch" | "kmer" = "sketch";
let exactVisualization: ExactVisualizationMode = DEFAULT_EXACT_VISUALIZATION;
const exactGeometry: ExactKmerGeometry = DEFAULT_EXACT_KMER_GEOMETRY;
let overviewReadyText = "Ready";
let plotStatusText = "Ready";
let featureTrackBusy = false;
let sequenceLoadPending = false;
let wasmBytes = 0;
let heatmapRange: HeatmapRange = { minimum: 85, midpoint: 92, maximum: 100 };
let paletteReversed = DEFAULT_PALETTE_REVERSED;
let activePaletteColorIndex: number | null = null;
let paletteColorInvoker: HTMLButtonElement | null = null;
const paletteColorOverrides = new Map<string, string[]>();
let histogramBins = new Uint32Array(101);
const histogramTiles = new Set<string>();
const GRID_OVERVIEW_RESOLUTION = 512;
interface GridRunEntry {
  comparison: GridComparison;
  renderer: GridPairRenderer;
  cells: HTMLButtonElement[];
}
interface GridRun {
  entries: GridRunEntry[];
  activeEntry: number;
  activeGeneration: number | null;
}
let gridRun: GridRun | null = null;
let pendingDetailedExport: {
  generation: number;
  requestId: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  onProgress: (message: string, progress?: number) => void;
} | null = null;

function handleWorkerMessage(event: MessageEvent<WorkerToMainMessage>): void {
  const message = event.data;
  switch (message.type) {
    case "ready":
      if (recoveryBundledExample) {
        const example = recoveryBundledExample;
        recoveryBundledExample = null;
        post({
          type: "load-precomputed-overview",
          generation,
          source: example.source,
          artifact: example.artifact,
        });
      } else if (recoveryFiles) {
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
      if (message.generation !== generation) break;
      if (status.classList.contains("error")) break;
      if (sequenceLoadPending && launchValidationPending && !landing.hidden) {
        const progress = message.progress === undefined
          ? ""
          : ` · ${Math.min(99, Math.floor(message.progress * 100))}%`;
        fastaSelection.textContent = `${message.text}${progress}`;
        if (launchExampleWhenReady) {
          const indexedProgress = message.progress === undefined
            ? 0.95
            : 0.95 + Math.min(1, message.progress) * 0.05;
          showExampleProgress(message.text, indexedProgress);
        }
      }
      if (plotMode === "grid" && gridRun && gridRun.activeGeneration !== null) {
        const cellProgress = message.progress ?? 0;
        const overallProgress = (gridRun.activeEntry + cellProgress) / gridRun.entries.length;
        plotStatusText = `Grid ${gridRun.activeEntry + 1}/${gridRun.entries.length} · ${message.text}`;
        status.textContent = plotStatusText;
        if (message.busy) showProgress(plotStatusText, overallProgress);
        else hideProgress();
        break;
      }
      plotStatusText = message.text;
      status.textContent = message.text;
      if (pendingDetailedExport && message.busy) {
        pendingDetailedExport.onProgress(message.text, message.progress);
      }
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
      if (launchValidationPending) {
        launchValidationPending = false;
        launchReady = true;
        fastaSelection.textContent = activeBundledExample
          ? `${activeBundledExample.source.fileName} ready to explore`
          : `${fileList(stagedFastaFiles)} ready to explore`;
        dropZone.classList.add("has-selection");
        exploreButton.hidden = false;
        plotStatusText = "Ready to explore";
        status.textContent = plotStatusText;
        hideProgress();
        if (launchExampleWhenReady) {
          launchExampleWhenReady = false;
          showExampleProgress("Included genome ready", 1);
          resetExampleButton();
          enterWorkspace();
          if (activeBundledExample) void loadBundledAnnotation(activeBundledExample);
        }
        break;
      }
      setPlotMode("self");
      break;
    case "comparison-ready":
      if (message.generation !== generation) return;
      if (gridRun?.activeGeneration === message.generation) break;
      comparisonReady = true;
      activeConfigurations = message.configurations;
      exportDataButton.disabled = renderer.exportTileViews().length === 0;
      exportImageButton.disabled = renderer.exportTileViews().length === 0;
      updateScientificProvenance(message.configurations, message.parameters.k);
      updateExactModeUi();
      plotStatusText = currentMeasurement === "kmer"
        ? `Drawing exact k-mers · ${exactGeometryLabel(exactGeometry).toLowerCase()}`
        : "Drawing quick overview";
      status.textContent = plotStatusText;
      if (pendingView && requestedResolution(pendingView) > message.parameters.resolution) {
        cancelAndQueueVisibleDetail(0);
      }
      queueFeatureTracks(180);
      break;
    case "preview-complete":
      if (message.generation !== generation || message.requestId !== tileRequestId) return;
      if (gridRun?.activeGeneration === message.generation) {
        post({
          type: "preview-presented",
          generation: message.generation,
          requestId: message.requestId,
        });
        break;
      }
      void renderer.present().then(() => {
        if (message.generation !== generation || message.requestId !== tileRequestId) return;
        post({
          type: "preview-presented",
          generation: message.generation,
          requestId: message.requestId,
        });
      });
      break;
    case "export-ready": {
      const pending = pendingDetailedExport;
      if (!pending || message.generation !== pending.generation || message.requestId !== pending.requestId) return;
      pendingDetailedExport = null;
      plotStatusText = "Ready · detailed export prepared";
      status.textContent = plotStatusText;
      hideProgress();
      pending.resolve();
      break;
    }
    case "tile":
      if (message.generation !== generation) return;
      if (gridRun?.activeGeneration === message.generation) {
        const entry = gridRun.entries[gridRun.activeEntry];
        entry?.renderer.addTile(message);
        updateMemory();
        break;
      }
      renderer.addTile(message);
      if (pendingLandingAnnotations.length > 0) {
        const annotations = pendingLandingAnnotations;
        pendingLandingAnnotations = [];
        queueMicrotask(() => importedTracks.importFilesForSequences(annotations, sequences));
      }
      if (comparisonReady) {
        exportDataButton.disabled = false;
        exportImageButton.disabled = false;
      }
      setPlotLoading(false);
      collectHistogram(message);
      updateMemory();
      break;
    case "complete":
      if (message.generation !== generation) return;
      if (gridRun?.activeGeneration === message.generation) {
        completeGridEntry(message.generation, message.estimatedBytes);
        break;
      }
      wasmBytes = message.estimatedBytes;
      overviewReadyText = message.precomputed
        ? "Ready · precomputed"
        : `Ready · ${(message.elapsedMs / 1000).toFixed(1)} s`;
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
      cancelPendingDetailedExport(new Error(message.message));
      featureTrackBusy = false;
      if (sequenceLoadPending) rejectSequenceLoad(message.message);
      else if (plotMode === "grid" && gridRun) {
        const entry = gridRun.entries[gridRun.activeEntry];
        for (const cell of entry?.cells ?? []) setGridCellStatus(cell, "Failed", "error");
        gridRun.activeGeneration = null;
        for (const cell of plotGrid.querySelectorAll<HTMLButtonElement>(".grid-plot-cell.is-ready")) {
          cell.disabled = false;
        }
        updateMemory();
        showError(`Grid comparison failed: ${message.message}`);
      }
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
  if (files.length) {
    if (landing.hidden) loadFiles(files);
    else stageFastaFiles(files);
  }
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
  if (files.length) stageFastaFiles(files);
});

annotationDropZone.addEventListener("click", () => annotationFileInput.click());
annotationFileInput.addEventListener("change", () => {
  const files = [...(annotationFileInput.files ?? [])];
  annotationFileInput.value = "";
  if (files.length) stageAnnotationFiles(files);
});
for (const eventName of ["dragenter", "dragover"]) {
  annotationDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    annotationDropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  annotationDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    annotationDropZone.classList.remove("is-dragging");
  });
}
annotationDropZone.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) stageAnnotationFiles(files);
});
exploreButton.addEventListener("click", enterWorkspace);
exampleButton.addEventListener("click", () => void launchBundledExample());

function enterWorkspace(): void {
  if (!launchReady || sequences.length === 0) return;
  launchReady = false;
  hideExampleProgress();
  pendingLandingAnnotations = [...stagedAnnotationFiles];
  landing.hidden = true;
  workspace.hidden = false;
  clearButton.hidden = false;
  status.classList.remove("error");
  plotStatusText = "Preparing plot";
  status.textContent = plotStatusText;
  showProgress(plotStatusText);
  setPlotLoading(true);
  setPlotMode("self");
}

for (const button of plotModeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.plotMode;
    if (mode === "grid" && gridReturnAvailable && gridRun) returnToGrid();
    else if (mode === plotMode && gridReturnAvailable) return;
    else if (mode === "self" || mode === "pairwise" || mode === "grid") setPlotMode(mode);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const current = plotModeButtons.indexOf(button);
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = plotModeButtons[(current + direction + plotModeButtons.length) % plotModeButtons.length];
    const mode = next?.dataset.plotMode;
    if (!next || (mode !== "self" && mode !== "pairwise" && mode !== "grid")) return;
    event.preventDefault();
    next.focus();
    if (mode === "grid" && gridReturnAvailable && gridRun) returnToGrid();
    else setPlotMode(mode);
  });
}
backToGridButton.addEventListener("click", returnToGrid);
cursorGuidesEnabled.addEventListener("change", updateCursorGuideControlState);
updateCursorGuideControlState();
selfSelect.addEventListener("change", () => {
  updateParameterNotes();
  if (plotMode === "self") queueComparison(150);
});
for (const [control, changedAxis] of [
  [xSelect, "x"],
  [ySelect, "y"],
] as const) {
  control.addEventListener("change", () => {
    synchronizePairwiseSelection(changedAxis);
    updateParameterNotes();
    if (plotMode === "pairwise") queueComparison(150);
  });
}
gridSizeSelect.addEventListener("change", () => {
  updateGridSelections(Number(gridSizeSelect.value));
  if (plotMode === "grid") queueGrid(150);
});
for (const control of [resolutionSelect, previewRegisterSelect, detailedRegisterSelect, kmerInput]) {
  control.addEventListener("change", () => {
    const previousPreviewRegisters = Number(previewRegisterSelect.value);
    normalizeRegisterControls(control);
    updateParameterNotes();
    if (plotMode === "grid") {
      const gridParametersChanged = control === previewRegisterSelect
        || control === kmerInput
        || Number(previewRegisterSelect.value) !== previousPreviewRegisters;
      if (gridParametersChanged) queueGrid(150);
    } else {
      queueComparison(150);
    }
  });
}
for (const [name, input] of Object.entries(heatmapInputs) as Array<[keyof HeatmapRange, HTMLInputElement]>) {
  input.addEventListener("input", () => updateHeatmap(name));
}
heatmapPaletteSelect.addEventListener("change", () => {
  const palette = selectedHeatmapPalette();
  updatePaletteColorCountControl(palette);
  paletteReversed = palette === DEFAULT_HEATMAP_PALETTE && DEFAULT_PALETTE_REVERSED;
  closePaletteColorEditor(false);
  updatePaletteDirectionControl();
  renderPaletteSwatches();
  updateHeatmapAppearance();
});
heatmapColorCountInput.addEventListener("change", () => {
  updatePaletteColorCountControl(selectedHeatmapPalette());
  closePaletteColorEditor(false);
  renderPaletteSwatches();
  updateHeatmapAppearance();
});
paletteFlipButton.addEventListener("click", () => {
  paletteReversed = !paletteReversed;
  closePaletteColorEditor(false);
  updatePaletteDirectionControl();
  renderPaletteSwatches();
  updateHeatmapAppearance();
});
paletteColorWheel.addEventListener("input", () => applyPaletteColor(paletteColorWheel.value, true, true));
paletteColorWheel.addEventListener("change", () => applyPaletteColor(paletteColorWheel.value, true, false));
paletteColorHex.addEventListener("input", () => {
  const color = parseHexColor(paletteColorHex.value);
  paletteColorHex.setAttribute("aria-invalid", String(color === null));
  if (color) applyPaletteColor(color, false, true);
  else paletteColorMessage.textContent = "Enter a six-digit hex color, such as #5e4fa2.";
});
paletteColorHex.addEventListener("change", () => {
  const color = parseHexColor(paletteColorHex.value);
  if (color) applyPaletteColor(color, true, false);
  else restorePaletteEditorColor();
});
paletteColorReset.addEventListener("click", resetActivePaletteColor);
paletteColorDone.addEventListener("click", () => closePaletteColorEditor(true));
paletteColorEditor.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePaletteColorEditor(true);
});
for (const button of exactViewButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.exactView;
    if (mode === "identity" || mode === "bases") setExactVisualization(mode);
  });
}
for (const button of backgroundButtons) {
  button.addEventListener("click", () => {
    for (const peer of backgroundButtons) peer.setAttribute("aria-pressed", String(peer === button));
    updateHeatmapAppearance();
    updateExactModeUi();
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
    setColorMode(mode);
  });
}
resetViewButton.addEventListener("click", () => renderer.resetView());
new ExportController({
  dataButton: exportDataButton,
  imageButton: exportImageButton,
  shell: plotShell,
  plotFrame,
  renderer,
  axes,
  baseName: currentExportBaseName,
  provenance: currentExportProvenance,
  numericContext: currentNumericExportContext,
  prepareDetailedExport,
  progressDialog: exportProgressDialog,
  progressMessage: exportProgressMessage,
  progressBar: exportProgressBar,
  onError: showError,
  canExport: () => comparisonReady && renderer.exportTileViews().length > 0,
});
clearButton.addEventListener("click", clearSession);
retryEngineButton.addEventListener("click", restartEngine);
renderer.onHover(showHover);
renderer.onViewChange((change) => {
  cancelPendingDetailedExport(new Error("Export cancelled because the plot view changed."));
  pendingView = change;
  if (activeParameters && plotMode !== "grid") {
    currentMeasurement = requestedResolution(change) === Math.floor(activeDomainLength)
      ? "kmer"
      : "sketch";
    updateScientificProvenance(activeConfigurations, activeParameters.k);
    updateExactModeUi();
  }
  updatePlotWindowSize();
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
populatePaletteControls();
updateHeatmap("midpoint");
drawHistogram();
updateParameterNotes();
updateExactModeUi();

function stageFastaFiles(files: File[], launchAutomatically = false): void {
  cancelExampleLoad();
  launchExampleWhenReady = launchAutomatically;
  const annotations = files.filter((file) => isAnnotationFileName(file.name));
  if (annotations.length > 0) {
    showSequenceLoadDialog(
      `${fileList(annotations)} ${annotations.length === 1 ? "is an annotation file" : "are annotation files"}, not FASTA sequence input.`,
      ["Use the smaller annotation drop area underneath the FASTA drop area."],
    );
    return;
  }
  activeBundledExample = null;
  recoveryBundledExample = null;
  stagedFastaFiles = [...files];
  launchReady = false;
  fastaSelection.textContent = `Reading and validating ${fileList(files)}…`;
  fastaSelection.title = files.map((file) => file.name).join("\n");
  dropZone.classList.add("has-selection");
  exploreButton.hidden = true;
  if (launchAutomatically) {
    exampleButton.disabled = true;
    exampleButton.textContent = "Preparing included genome…";
  }
  if (workerFailed) startWorker();
  loadFiles(files, true, true);
}

async function launchBundledExample(): Promise<void> {
  clearSession();
  const controller = new AbortController();
  exampleLoadController = controller;
  exampleButton.disabled = true;
  exampleButton.textContent = "Loading included genome…";
  fastaSelection.textContent = "Loading precomputed Col-CEN_v1.2 overview…";
  annotationSelection.textContent = "Annotations load after the plot opens";
  showExampleProgress("Loading precomputed Arabidopsis overview", 0);

  try {
    const example = await loadBundledArabidopsisExample({
      signal: controller.signal,
      onProgress: (message, progress) => {
        if (controller.signal.aborted || exampleLoadController !== controller) return;
        showExampleProgress(message, progress);
        fastaSelection.textContent = `${message} · ${Math.floor(progress * 100)}%`;
      },
    });
    if (controller.signal.aborted || exampleLoadController !== controller) return;
    exampleLoadController = null;
    stagePrecomputedExample(example);
  } catch (error) {
    if (isAbortError(error) || exampleLoadController !== controller) return;
    exampleLoadController = null;
    resetExampleButton();
    hideExampleProgress();
    fastaSelection.textContent = "No FASTA selected";
    annotationSelection.textContent = "No annotations selected";
    showSequenceLoadDialog(
      "The included Arabidopsis example could not be loaded.",
      [error instanceof Error ? error.message : String(error), "Reload the page or choose local FASTA files instead."],
    );
  }
}

function stagePrecomputedExample(example: ArabidopsisExampleStartup): void {
  activeBundledExample = example;
  recoveryBundledExample = null;
  lastFiles = [];
  stagedFastaFiles = [];
  stagedAnnotationFiles = [];
  pendingLandingAnnotations = [];
  generation += 1;
  tileRequestId += 1;
  featureTrackRequestId += 1;
  sequenceLoadPending = true;
  launchValidationPending = true;
  launchExampleWhenReady = true;
  launchReady = false;
  fastaSelection.textContent = `Validating ${example.source.fileName} overview…`;
  fastaSelection.title = `${example.source.fileName} · remote ranges load only when needed`;
  annotationSelection.textContent = "Annotations load after the plot opens";
  dropZone.classList.add("has-selection");
  exploreButton.hidden = true;
  if (workerFailed) startWorker();
  post({
    type: "load-precomputed-overview",
    generation,
    source: example.source,
    artifact: example.artifact,
  });
}

async function loadBundledAnnotation(
  example: ArabidopsisExampleStartup,
): Promise<void> {
  exampleAnnotationController?.abort(new DOMException("Annotation load was replaced.", "AbortError"));
  const controller = new AbortController();
  exampleAnnotationController = controller;
  annotationSelection.textContent = "Loading included CEN180 annotations · 0%";
  try {
    const annotation = await loadBundledArabidopsisAnnotation({
      signal: controller.signal,
      onProgress: (_message, progress) => {
        if (
          controller.signal.aborted
          || exampleAnnotationController !== controller
          || activeBundledExample !== example
        ) return;
        annotationSelection.textContent = `Loading included CEN180 annotations · ${Math.floor(progress * 100)}%`;
      },
    });
    if (
      controller.signal.aborted
      || exampleAnnotationController !== controller
      || activeBundledExample !== example
    ) return;
    exampleAnnotationController = null;
    stagedAnnotationFiles = [annotation];
    annotationSelection.textContent = `${annotation.name} loaded`;
    annotationSelection.title = annotation.name;
    annotationDropZone.classList.add("has-selection");
    if (comparisonReady && renderer.exportTileViews().length > 0) {
      importedTracks.importFilesForSequences([annotation], sequences);
    } else {
      pendingLandingAnnotations = [annotation];
    }
  } catch (error: unknown) {
    if (isAbortError(error) || exampleAnnotationController !== controller) return;
    exampleAnnotationController = null;
    annotationSelection.textContent = "Included CEN180 annotations unavailable";
    annotationSelection.title = error instanceof Error ? error.message : String(error);
    annotationDropZone.classList.remove("has-selection");
  }
}

function cancelExampleLoad(): void {
  const wasLoading = exampleLoadController !== null || exampleAnnotationController !== null;
  const reason = new DOMException("The example load was cancelled.", "AbortError");
  exampleLoadController?.abort(reason);
  exampleAnnotationController?.abort(reason);
  exampleLoadController = null;
  exampleAnnotationController = null;
  launchExampleWhenReady = false;
  resetExampleButton();
  if (wasLoading && !landing.hidden) {
    hideExampleProgress();
    restoreLandingSelections();
  }
}

function resetExampleButton(): void {
  exampleButton.disabled = false;
  exampleButton.textContent = "Try ModDotPlot on an Arabadopsis genome";
}

function showExampleProgress(label: string, progress: number): void {
  const bounded = Math.max(0, Math.min(1, progress));
  exampleProgress.hidden = false;
  exampleProgressLabel.textContent = label;
  exampleProgressValue.textContent = `${Math.round(bounded * 100)}%`;
  exampleProgressBar.value = bounded;
}

function hideExampleProgress(): void {
  exampleProgress.hidden = true;
  exampleProgressBar.value = 0;
  exampleProgressValue.textContent = "0%";
}

function restoreLandingSelections(): void {
  fastaSelection.textContent = activeBundledExample
    ? `${activeBundledExample.source.fileName} ready to explore`
    : stagedFastaFiles.length > 0
      ? `${fileList(stagedFastaFiles)} ready to explore`
      : "No FASTA selected";
  annotationSelection.textContent = stagedAnnotationFiles.length > 0
    ? `${fileList(stagedAnnotationFiles)} selected`
    : "No annotations selected";
  dropZone.classList.toggle("has-selection", activeBundledExample !== null || stagedFastaFiles.length > 0);
  annotationDropZone.classList.toggle("has-selection", stagedAnnotationFiles.length > 0);
  exploreButton.hidden = !launchReady;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function stageAnnotationFiles(files: File[]): void {
  if (exampleLoadController || exampleAnnotationController) cancelExampleLoad();
  const unsupported = files.filter((file) => !isAnnotationFileName(file.name));
  if (unsupported.length > 0) {
    showSequenceLoadDialog(
      `${fileList(unsupported)} ${unsupported.length === 1 ? "is not a supported annotation file" : "are not supported annotation files"}.`,
      ["Choose BED, GFF3, or GTF files, optionally compressed with gzip or BGZF."],
    );
    return;
  }
  stagedAnnotationFiles = [...files];
  annotationSelection.textContent = `${fileList(files)} selected`;
  annotationSelection.title = files.map((file) => file.name).join("\n");
  annotationDropZone.classList.add("has-selection");
}

function loadFiles(files: File[], remember = true, validateForLaunch = false): void {
  cancelPendingDetailedExport(new Error("Export cancelled because new files are loading."));
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
  window.clearTimeout(gridPrepareTimer);
  generation += 1;
  tileRequestId += 1;
  featureTrackRequestId += 1;
  sequences = [];
  plotMode = "self";
  gridSelectedIndices = [];
  comparisonReady = false;
  currentMeasurement = "sketch";
  activeParameters = null;
  activeConfigurations = [];
  exportDataButton.disabled = true;
  exportImageButton.disabled = true;
  activeFeatureTrackMetadata = null;
  pendingView = null;
  featureTrackBusy = false;
  sequenceLoadPending = true;
  launchValidationPending = validateForLaunch;
  if (!validateForLaunch) launchReady = false;
  selfSelect.replaceChildren();
  xSelect.replaceChildren();
  ySelect.replaceChildren();
  gridSizeSelect.replaceChildren();
  gridSequenceSelectors.replaceChildren();
  plotModeTabs.hidden = true;
  clearGrid();
  xSequenceLabel.textContent = "";
  ySequenceLabel.textContent = "";
  renderer.clearTiles();
  updateExactModeUi();
  featureTracks.clear();
  importedTracks.clear();
  setPlotLoading(!validateForLaunch);
  landing.hidden = !validateForLaunch;
  workspace.hidden = validateForLaunch;
  clearButton.hidden = validateForLaunch;
  retryEngineButton.hidden = true;
  status.classList.remove("error");
  plotStatusText = "Reading and validating sequence";
  status.textContent = plotStatusText;
  if (validateForLaunch) hideProgress();
  else showProgress(plotStatusText);
  post({ type: "load", generation, files });
}

function populateSelectors(): void {
  const options = sequences.map((sequence) => {
    const option = document.createElement("option");
    option.value = String(sequence.index);
    option.textContent = `${sequence.selectionId} · ${formatBases(sequence.length)}`;
    option.title = `${sequenceAxisLabel(sequence)} · ${sequence.sourceFile}`;
    return option;
  });
  selfSelect.replaceChildren(...options.map((option) => option.cloneNode(true)));
  xSelect.replaceChildren(...options.map((option) => option.cloneNode(true)));
  ySelect.replaceChildren(...options.map((option) => option.cloneNode(true)));
  selfSelect.value = String(sequences[0]?.index ?? 0);
  xSelect.value = String(sequences[0]?.index ?? 0);
  ySelect.value = String(sequences[0]?.index ?? 0);
  synchronizePairwiseSelection();
  const sizes = validGridSizes(sequences.length);
  gridSizeSelect.replaceChildren(...sizes.map((size) => Object.assign(document.createElement("option"), {
    value: String(size),
    textContent: `${size} sequences`,
  })));
  if (sizes.length > 0) {
    gridSizeSelect.value = String(Math.min(3, sizes.at(-1) ?? 2));
    updateGridSelections(Number(gridSizeSelect.value));
  }
  plotModeTabs.hidden = sequences.length <= 1;
  updateParameterNotes();
}

function selectedSingleComparison(): { xIndex: number; yIndex: number } | null {
  if (plotMode === "grid") return null;
  if (plotMode === "self") {
    const index = Number(selfSelect.value);
    return Number.isSafeInteger(index) ? { xIndex: index, yIndex: index } : null;
  }
  return synchronizePairwiseSelection();
}

function synchronizePairwiseSelection(changedAxis?: PairwiseAxis): PairwiseSelection | null {
  const selection = normalizePairwiseSelection(
    sequences.map((sequence) => sequence.index),
    { xIndex: Number(xSelect.value), yIndex: Number(ySelect.value) },
    changedAxis,
  );
  if (!selection) return null;
  xSelect.value = String(selection.xIndex);
  ySelect.value = String(selection.yIndex);
  return selection;
}

function setPlotMode(
  requestedMode: PlotMode,
  navigation: { preserveGrid?: boolean; restoreGrid?: boolean } = {},
): void {
  const nextMode = sequences.length <= 1 ? "self" : requestedMode;
  if (nextMode === "pairwise") synchronizePairwiseSelection();
  const modeChanged = plotMode !== nextMode;
  if (!modeChanged && nextMode === "grid" && !plotGridView.hidden) {
    updateParameterNotes();
    return;
  }
  plotMode = nextMode;
  window.clearTimeout(prepareTimer);
  window.clearTimeout(detailTimer);
  window.clearTimeout(featureTrackTimer);
  window.clearTimeout(gridPrepareTimer);
  if (modeChanged) {
    generation += 1;
    tileRequestId += 1;
    featureTrackRequestId += 1;
    comparisonReady = false;
    featureTrackBusy = false;
    cancelPendingDetailedExport(new Error("Export cancelled because the plot type changed."));
  }
  for (const button of plotModeButtons) {
    const selected = button.dataset.plotMode === plotMode;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const [mode, panel] of Object.entries(plotModePanels) as Array<[PlotMode, HTMLElement]>) {
    panel.hidden = mode !== plotMode;
  }
  const gridActive = plotMode === "grid";
  plotShell.hidden = gridActive;
  plotGridView.hidden = !gridActive;
  backToGridButton.hidden = gridActive || !gridReturnAvailable;
  featureTrackControls.hidden = gridActive;
  plotActions.hidden = gridActive;
  histogramCanvas.hidden = gridActive;
  hoverCard.hidden = true;
  cursorGuideController.hide();
  if (gridActive) {
    renderer.clearTiles();
    featureTracks.clear();
    comparisonReady = false;
    activeParameters = null;
    activeConfigurations = [];
    activeFeatureTrackMetadata = null;
    pendingView = null;
    exportDataButton.disabled = true;
    exportImageButton.disabled = true;
    setPlotLoading(false);
    scientificProvenance.textContent = `Grid overview · up to ${GRID_OVERVIEW_RESOLUTION.toLocaleString()} × ${GRID_OVERVIEW_RESOLUTION.toLocaleString()} cells · quick-view accuracy`;
    scientificProvenance.title = "Open a grid cell for the fully interactive view and detailed export.";
    if (navigation.restoreGrid && gridRun) {
      gridReturnAvailable = false;
      backToGridButton.hidden = true;
      plotStatusText = `Ready · ${gridRun.entries.length} grid comparisons`;
      status.classList.remove("error");
      status.textContent = plotStatusText;
      hideProgress();
      updateGridAppearance();
    } else {
      queueGrid(0);
    }
  } else {
    if (!navigation.preserveGrid) clearGrid();
    queueComparison(0);
  }
  updateExactModeUi();
  updateParameterNotes();
  updateMemory();
}

function returnToGrid(): void {
  if (!gridReturnAvailable || !gridRun) return;
  const returnCell = gridReturnCell;
  if (activeParameters) {
    tileRequestId += 1;
    post({ type: "cancel-tiles", generation, requestId: tileRequestId });
  }
  setPlotMode("grid", { restoreGrid: true });
  gridReturnCell = null;
  if (returnCell?.isConnected && !returnCell.disabled) returnCell.focus();
  else plotModeButtons.find((button) => button.dataset.plotMode === "grid")?.focus();
}

function updateGridSelections(requestedSize: number, focusPosition?: number): void {
  gridSelectedIndices = normalizeGridSelections(
    sequences.map((sequence) => sequence.index),
    gridSelectedIndices,
    requestedSize,
  );
  if (gridSelectedIndices.length === 0) {
    gridSequenceSelectors.replaceChildren();
    return;
  }
  gridSizeSelect.value = String(gridSelectedIndices.length);
  const selectedSet = new Set(gridSelectedIndices);
  const controls = gridSelectedIndices.map((selectedIndex, position) => {
    const label = document.createElement("label");
    const title = document.createElement("span");
    title.textContent = `Sequence ${position + 1}`;
    const select = document.createElement("select");
    select.className = "grid-sequence-select";
    select.dataset.gridPosition = String(position);
    select.setAttribute("aria-label", `Grid sequence ${position + 1}`);
    select.replaceChildren(...sequences.map((sequence) => {
      const option = document.createElement("option");
      option.value = String(sequence.index);
      option.textContent = `${sequence.selectionId} · ${formatBases(sequence.length)}`;
      option.title = `${sequenceAxisLabel(sequence)} · ${sequence.sourceFile}`;
      option.disabled = sequence.index !== selectedIndex && selectedSet.has(sequence.index);
      return option;
    }));
    select.value = String(selectedIndex);
    select.addEventListener("change", () => {
      const replacement = Number(select.value);
      gridSelectedIndices = gridSelectedIndices.map((index, indexPosition) =>
        indexPosition === position ? replacement : index);
      updateGridSelections(gridSelectedIndices.length, position);
      if (plotMode === "grid") queueGrid(150);
    });
    label.append(title, select);
    return label;
  });
  gridSequenceSelectors.replaceChildren(...controls);
  if (focusPosition !== undefined) {
    gridSequenceSelectors
      .querySelector<HTMLSelectElement>(`[data-grid-position="${focusPosition}"]`)
      ?.focus();
  }
  const count = gridSelectedIndices.length;
  const pairCount = count * (count - 1) / 2;
  gridSelectionNote.textContent = `${count} self + ${pairCount} unique pairwise overviews · pairs are computed once and transposed · maximum 6 sequences`;
}

function queueGrid(delay: number): void {
  window.clearTimeout(gridPrepareTimer);
  if (plotMode !== "grid" || gridSelectedIndices.length < 2) return;
  const activeGeneration = gridRun?.activeGeneration;
  if (activeGeneration !== null && activeGeneration !== undefined) {
    tileRequestId += 1;
    post({ type: "cancel-tiles", generation: activeGeneration, requestId: tileRequestId });
  }
  generation += 1;
  clearGrid();
  plotStatusText = "Preparing grid overview";
  status.textContent = plotStatusText;
  showProgress(plotStatusText, 0);
  gridPrepareTimer = window.setTimeout(startGrid, delay);
}

function startGrid(): void {
  if (plotMode !== "grid") return;
  const comparisons = planGridComparisons(gridSelectedIndices);
  if (comparisons.length === 0) return;
  status.classList.remove("error");
  const run: GridRun = {
    entries: createGridEntries(comparisons),
    activeEntry: 0,
    activeGeneration: null,
  };
  gridRun = run;
  updateGridAppearance();
  prepareNextGridEntry(run);
  updateMemory();
}

function createGridEntries(comparisons: readonly GridComparison[]): GridRunEntry[] {
  const selected = gridSelectedIndices.map((index) => sequences.find((sequence) =>
    sequence.index === index)).filter((sequence): sequence is SequenceMetadata => Boolean(sequence));
  const selectedByIndex = new Map(selected.map((sequence) => [sequence.index, sequence]));
  const gridDomainLength = Math.max(1, ...selected.map((sequence) => sequence.length));
  plotGrid.style.setProperty("--grid-size", String(selected.length));
  plotGrid.dataset.domainLength = String(gridDomainLength);
  const corner = Object.assign(document.createElement("div"), {
    className: "plot-grid-corner",
    textContent: "Y ↑ · X →",
  });
  corner.style.gridColumn = "1";
  corner.style.gridRow = "1";
  const children: HTMLElement[] = [corner];
  for (const sequence of selected) {
    children.push(
      createGridAxisLabel(sequence, "x"),
      createGridAxisLabel(sequence, "y"),
    );
  }

  const cells = new Map<string, { button: HTMLButtonElement; canvas: HTMLCanvasElement }>();
  for (let row = 0; row < selected.length; row += 1) {
    for (let column = 0; column < selected.length; column += 1) {
      const x = selected[column]!;
      const y = selected[row]!;
      const button = document.createElement("button");
      button.type = "button";
      const selfComparison = x.index === y.index;
      button.className = `grid-plot-cell${selfComparison ? " is-diagonal" : ""}`;
      button.dataset.gridRow = String(row);
      button.dataset.gridColumn = String(column);
      button.dataset.xIndex = String(x.index);
      button.dataset.yIndex = String(y.index);
      button.dataset.xLength = String(x.length);
      button.dataset.yLength = String(y.length);
      button.dataset.canonical = String(row >= column);
      const actionLabel = selfComparison
        ? `Open self plot for ${x.selectionId}`
        : `Open pairwise plot with ${x.selectionId} on X and ${y.selectionId} on Y`;
      button.dataset.gridActionLabel = actionLabel;
      button.setAttribute("aria-label", `${actionLabel}. Status: Queued`);
      const cellCanvas = document.createElement("canvas");
      cellCanvas.width = GRID_OVERVIEW_RESOLUTION;
      cellCanvas.height = GRID_OVERVIEW_RESOLUTION;
      cellCanvas.setAttribute("aria-hidden", "true");
      const cellStatus = Object.assign(document.createElement("span"), {
        className: "grid-plot-cell-status",
        textContent: "Queued",
      });
      button.disabled = true;
      button.append(cellCanvas, cellStatus);
      button.addEventListener("click", () => {
        if (button.disabled || !gridRun || gridRun.activeGeneration !== null) return;
        const targetMode: PlotMode = selfComparison ? "self" : "pairwise";
        if (selfComparison) {
          selfSelect.value = String(x.index);
        } else {
          xSelect.value = String(x.index);
          ySelect.value = String(y.index);
        }
        gridReturnAvailable = true;
        gridReturnCell = button;
        setPlotMode(targetMode, { preserveGrid: true });
        plotModeButtons.find((candidate) => candidate.dataset.plotMode === targetMode)?.focus();
      });
      cells.set(`${x.index}:${y.index}`, { button, canvas: cellCanvas });
      children.push(button);
    }
  }
  plotGrid.replaceChildren(...children);
  layoutGridEntries();
  return comparisons.map((comparison) => {
    const normal = cells.get(`${comparison.xIndex}:${comparison.yIndex}`);
    const mirror = comparison.selfComparison
      ? null
      : cells.get(`${comparison.yIndex}:${comparison.xIndex}`) ?? null;
    if (!normal) throw new Error("Grid planner produced a cell outside the selected matrix");
    const x = selectedByIndex.get(comparison.xIndex);
    const y = selectedByIndex.get(comparison.yIndex);
    if (!x || !y) throw new Error("Grid planner referenced an unavailable sequence");
    const pairDomainLength = Math.max(1, x.length, y.length);
    const entryCells = mirror ? [normal.button, mirror.button] : [normal.button];
    return {
      comparison,
      renderer: new GridPairRenderer(
        normal.canvas,
        mirror?.canvas ?? null,
        pairDomainLength / gridDomainLength,
      ),
      cells: entryCells,
    };
  });
}

function createGridAxisLabel(sequence: SequenceMetadata, axis: GridAxis): HTMLButtonElement {
  const label = document.createElement("button");
  label.type = "button";
  label.className = `plot-grid-axis-label plot-grid-axis-label-${axis === "x" ? "column" : "row"}`;
  label.dataset.gridAxis = axis;
  label.dataset.sequenceIndex = String(sequence.index);
  label.draggable = true;
  label.title = `${sequenceAxisLabel(sequence)}. Drag to reorder both grid axes.`;
  const handle = Object.assign(document.createElement("span"), {
    className: "plot-grid-drag-handle",
    textContent: "⠿",
  });
  handle.setAttribute("aria-hidden", "true");
  const text = Object.assign(document.createElement("span"), {
    className: "plot-grid-axis-label-text",
    textContent: sequence.selectionId,
  });
  label.append(handle, text);

  label.addEventListener("dragstart", (event) => {
    gridDraggedSequenceIndex = sequence.index;
    gridDraggedAxis = axis;
    label.classList.add("is-grid-drag-source");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(sequence.index));
    }
  });
  label.addEventListener("dragover", (event) => {
    if (gridDraggedSequenceIndex === null || gridDraggedAxis !== axis) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    for (const target of plotGrid.querySelectorAll(".is-grid-drop-target")) {
      target.classList.remove("is-grid-drop-target");
    }
    if (gridDraggedSequenceIndex !== sequence.index) label.classList.add("is-grid-drop-target");
  });
  label.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && label.contains(event.relatedTarget)) return;
    label.classList.remove("is-grid-drop-target");
  });
  label.addEventListener("drop", (event) => {
    if (gridDraggedSequenceIndex === null || gridDraggedAxis !== axis) return;
    event.preventDefault();
    const sourceIndex = gridDraggedSequenceIndex;
    finishGridAxisDrag();
    reorderGridSequence(sourceIndex, sequence.index, axis);
  });
  label.addEventListener("dragend", finishGridAxisDrag);
  label.addEventListener("keydown", (event) => {
    const delta = axis === "x"
      ? event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0
      : event.key === "ArrowDown" ? -1 : event.key === "ArrowUp" ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const position = gridSelectedIndices.indexOf(sequence.index);
    const targetIndex = gridSelectedIndices[position + delta];
    if (position >= 0 && targetIndex !== undefined) {
      reorderGridSequence(sequence.index, targetIndex, axis);
    }
  });
  return label;
}

function layoutGridEntries(): void {
  const count = gridSelectedIndices.length;
  const positionBySequence = new Map(
    gridSelectedIndices.map((sequenceIndex, position) => [sequenceIndex, position]),
  );
  plotGrid.style.setProperty("--grid-size", String(count));
  const labels = [...plotGrid.querySelectorAll<HTMLButtonElement>(".plot-grid-axis-label")];
  for (const label of labels) {
    const sequenceIndex = Number(label.dataset.sequenceIndex);
    const position = positionBySequence.get(sequenceIndex);
    const axis = label.dataset.gridAxis as GridAxis | undefined;
    if (position === undefined || !axis) continue;
    label.dataset.gridPosition = String(position);
    if (axis === "x") {
      label.style.gridColumn = String(position + 2);
      label.style.gridRow = "1";
    } else {
      label.style.gridColumn = "1";
      label.style.gridRow = String(count - position + 1);
    }
    const sequence = sequences.find((candidate) => candidate.index === sequenceIndex);
    const positionDescription = axis === "x"
      ? `${position + 1} from the left`
      : `${position + 1} from the bottom`;
    label.setAttribute(
      "aria-label",
      `Reorder ${sequence?.selectionId ?? "sequence"} on the ${axis.toUpperCase()} axis, position ${positionDescription}. `
        + `Use ${axis === "x" ? "Left and Right" : "Up and Down"} arrow keys or drag to reorder both axes.`,
    );
  }
  const cells = [...plotGrid.querySelectorAll<HTMLButtonElement>(".grid-plot-cell")];
  for (const cell of cells) {
    const xPosition = positionBySequence.get(Number(cell.dataset.xIndex));
    const yPosition = positionBySequence.get(Number(cell.dataset.yIndex));
    if (xPosition === undefined || yPosition === undefined) continue;
    const visualRow = count - yPosition - 1;
    cell.dataset.gridColumn = String(xPosition);
    cell.dataset.gridRow = String(visualRow);
    cell.dataset.canonical = String(yPosition >= xPosition);
    cell.style.gridColumn = String(xPosition + 2);
    cell.style.gridRow = String(visualRow + 2);
  }

  // Match DOM and keyboard traversal to the visual grid without replacing any
  // retained canvas or renderer surface.
  const labelsByAxisAndSequence = new Map(
    labels.map((label) => [`${label.dataset.gridAxis}:${label.dataset.sequenceIndex}`, label]),
  );
  const cellsByPair = new Map(
    cells.map((cell) => [`${cell.dataset.xIndex}:${cell.dataset.yIndex}`, cell]),
  );
  const visualOrder: HTMLElement[] = [];
  const corner = plotGrid.querySelector<HTMLElement>(".plot-grid-corner");
  if (corner) visualOrder.push(corner);
  for (const xIndex of gridSelectedIndices) {
    const label = labelsByAxisAndSequence.get(`x:${xIndex}`);
    if (label) visualOrder.push(label);
  }
  for (const yIndex of [...gridSelectedIndices].reverse()) {
    const label = labelsByAxisAndSequence.get(`y:${yIndex}`);
    if (label) visualOrder.push(label);
    for (const xIndex of gridSelectedIndices) {
      const cell = cellsByPair.get(`${xIndex}:${yIndex}`);
      if (cell) visualOrder.push(cell);
    }
  }
  plotGrid.append(...visualOrder);
}

function reorderGridSequence(sourceIndex: number, targetIndex: number, axis: GridAxis): void {
  const sourcePosition = gridSelectedIndices.indexOf(sourceIndex);
  const targetPosition = gridSelectedIndices.indexOf(targetIndex);
  if (sourcePosition < 0 || targetPosition < 0 || sourcePosition === targetPosition) return;
  const reordered = [...gridSelectedIndices];
  const [moved] = reordered.splice(sourcePosition, 1);
  if (moved === undefined) return;
  reordered.splice(targetPosition, 0, moved);
  gridSelectedIndices = reordered;
  updateGridSelections(reordered.length);
  layoutGridEntries();
  const sequence = sequences.find((candidate) => candidate.index === sourceIndex);
  gridSelectionNote.textContent = `${sequence?.selectionId ?? "Sequence"} moved to position ${targetPosition + 1}. `
    + "X runs left to right; Y runs bottom to top.";
  window.requestAnimationFrame(() => {
    plotGrid.querySelector<HTMLButtonElement>(
      `.plot-grid-axis-label[data-grid-axis="${axis}"][data-sequence-index="${sourceIndex}"]`,
    )?.focus();
  });
}

function finishGridAxisDrag(): void {
  gridDraggedSequenceIndex = null;
  gridDraggedAxis = null;
  for (const target of plotGrid.querySelectorAll(".is-grid-drag-source, .is-grid-drop-target")) {
    target.classList.remove("is-grid-drag-source", "is-grid-drop-target");
  }
}

function prepareNextGridEntry(run: GridRun): void {
  if (gridRun !== run || plotMode !== "grid") return;
  const entry = run.entries[run.activeEntry];
  if (!entry) {
    run.activeGeneration = null;
    for (const cell of plotGrid.querySelectorAll<HTMLButtonElement>(".grid-plot-cell.is-ready")) {
      cell.disabled = false;
    }
    plotStatusText = `Ready · ${run.entries.length} grid comparisons`;
    status.textContent = plotStatusText;
    hideProgress();
    updateMemory();
    return;
  }
  const x = sequences.find((sequence) => sequence.index === entry.comparison.xIndex);
  const y = sequences.find((sequence) => sequence.index === entry.comparison.yIndex);
  if (!x || !y) {
    for (const cell of entry.cells) setGridCellStatus(cell, "Unavailable", "error");
    run.activeEntry += 1;
    queueMicrotask(() => prepareNextGridEntry(run));
    return;
  }
  for (const cell of entry.cells) setGridCellStatus(cell, "Drawing", "computing");
  generation += 1;
  tileRequestId += 1;
  run.activeGeneration = generation;
  const domainLength = Math.max(x.length, y.length);
  const overviewRegisters = Number(previewRegisterSelect.value);
  const parameters: ComparisonParameters = {
    xIndex: x.index,
    yIndex: y.index,
    resolution: Math.min(GRID_OVERVIEW_RESOLUTION, Math.max(1, domainLength)),
    previewRegisterCount: overviewRegisters,
    detailedRegisterCount: overviewRegisters,
    k: Number(kmerInput.value),
    exactGeometry,
  };
  const position = run.activeEntry + 1;
  plotStatusText = `Grid ${position}/${run.entries.length} · ${x.selectionId} vs ${y.selectionId}`;
  status.textContent = plotStatusText;
  showProgress(plotStatusText, run.activeEntry / run.entries.length);
  post({ type: "prepare", generation, requestId: tileRequestId, parameters });
}

function completeGridEntry(completedGeneration: number, estimatedBytes: number): void {
  const run = gridRun;
  if (!run || run.activeGeneration !== completedGeneration) return;
  const entry = run.entries[run.activeEntry];
  for (const cell of entry?.cells ?? []) setGridCellStatus(cell, "Ready", "ready");
  wasmBytes = estimatedBytes;
  run.activeEntry += 1;
  run.activeGeneration = null;
  updateMemory();
  queueMicrotask(() => prepareNextGridEntry(run));
}

function setGridCellStatus(
  cell: HTMLButtonElement,
  text: string,
  state: "queued" | "computing" | "ready" | "error",
): void {
  cell.classList.toggle("is-computing", state === "computing");
  cell.classList.toggle("is-ready", state === "ready");
  cell.classList.toggle("is-error", state === "error");
  const output = cell.querySelector<HTMLElement>(".grid-plot-cell-status");
  if (output) output.textContent = text;
  const actionLabel = cell.dataset.gridActionLabel;
  if (actionLabel) cell.setAttribute("aria-label", `${actionLabel}. Status: ${text}`);
}

function clearGrid(): void {
  window.clearTimeout(gridAppearanceTimer);
  gridAppearanceTimer = 0;
  finishGridAxisDrag();
  const run = gridRun;
  gridRun = null;
  if (run) {
    for (const entry of run.entries) entry.renderer.destroy();
  }
  gridReturnAvailable = false;
  gridReturnCell = null;
  backToGridButton.hidden = true;
  plotGrid.replaceChildren();
}

function updateGridAppearance(): void {
  window.clearTimeout(gridAppearanceTimer);
  gridAppearanceTimer = 0;
  const run = gridRun;
  if (!run || plotMode !== "grid") return;
  const darkBackground = backgroundButtons.some(
    (button) => button.dataset.backgroundMode === "black" && button.getAttribute("aria-pressed") === "true",
  );
  const mode = selectedColorMode();
  const palette = selectedHeatmapPalette();
  const colorCount = selectedHeatmapColorCount();
  const colors = activeHeatmapColors(palette, colorCount);
  for (const entry of run.entries) {
    entry.renderer.setColorMode(mode);
    entry.renderer.setHeatmapPalette(palette, colorCount, colors);
    entry.renderer.setHeatmapRange(heatmapRange.minimum, heatmapRange.midpoint, heatmapRange.maximum);
    entry.renderer.setDarkBackground(darkBackground);
  }
}

function queueGridAppearanceUpdate(): void {
  window.clearTimeout(gridAppearanceTimer);
  if (!gridRun || plotMode !== "grid") return;
  gridAppearanceTimer = window.setTimeout(() => {
    gridAppearanceTimer = 0;
    updateGridAppearance();
  }, 100);
}

function estimatedGridBytes(): number {
  const tileBytes = gridRun?.entries.reduce((total, entry) => total + entry.renderer.estimatedBytes(), 0) ?? 0;
  const canvasBytes = [...plotGrid.querySelectorAll<HTMLCanvasElement>("canvas")].reduce(
    (total, target) => total + target.width * target.height * 4,
    0,
  );
  return tileBytes + canvasBytes;
}

function queueComparison(delay: number): void {
  window.clearTimeout(prepareTimer);
  prepareTimer = window.setTimeout(prepareComparison, delay);
}

function prepareComparison(): void {
  cancelPendingDetailedExport(new Error("Export cancelled because the comparison changed."));
  const selection = selectedSingleComparison();
  if (!selection) return;
  const { xIndex, yIndex } = selection;
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
    k: Number(kmerInput.value),
    exactGeometry,
  };
  generation += 1;
  tileRequestId += 1;
  featureTrackRequestId += 1;
  comparisonReady = false;
  featureTrackBusy = false;
  currentMeasurement = parameters.resolution === activeDomainLength ? "kmer" : "sketch";
  overviewReadyText = "Ready";
  activeParameters = parameters;
  updateExactModeUi();
  activeConfigurations = [];
  exportDataButton.disabled = true;
  exportImageButton.disabled = true;
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
  const xAxisName = sequenceAxisLabel(x);
  const yAxisName = sequenceAxisLabel(y);
  axes.setMetadata({
    baseResolution: parameters.resolution,
    domainLength: activeDomainLength,
    xName: xAxisName,
    yName: yAxisName,
    xLength: x.length,
    yLength: y.length,
  });
  xSequenceLabel.textContent = xAxisName;
  xSequenceLabel.title = `${x.selectionId} · ${formatBases(x.length)} · ${x.sourceFile}`;
  ySequenceLabel.textContent = yAxisName;
  ySequenceLabel.title = `${y.selectionId} · ${formatBases(y.length)} · ${y.sourceFile}`;
  status.classList.remove("error");
  const preparationLabel = currentMeasurement === "kmer"
    ? `Drawing exact k-mers · ${exactGeometryLabel(exactGeometry).toLowerCase()}`
    : "Building overview signatures";
  plotStatusText = preparationLabel;
  status.textContent = preparationLabel;
  showProgress(preparationLabel, 0);
  post({ type: "prepare", generation, requestId: tileRequestId, parameters });
  post({
    type: "update-refinement-policy",
    generation,
    displayMinimum: Math.round(heatmapRange.minimum * 100),
  });
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
  updateScientificProvenance(activeConfigurations, parameters.k);
  updateExactModeUi();
  renderer.setActiveResolution(resolution);
  const tiles = selectTiles(resolution, parameters.resolution, change.view);
  const computeLabel = exactKmerLevel
    ? `Drawing exact k-mers · ${exactGeometryLabel(exactGeometry).toLowerCase()}`
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
    exactGeometry,
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
  const identity = datum.quality === "exact"
    ? exactIdentityLabel(datum.identity)
    : datum.identity === null
      ? "identity unavailable"
      : `identity ${datum.identity.toFixed(2)}%`;
  const xName = sequences.find((sequence) => sequence.index === activeParameters?.xIndex)?.name ?? "sequence";
  const yName = sequences.find((sequence) => sequence.index === activeParameters?.yIndex)?.name ?? "sequence";
  const lines = [
    Object.assign(document.createElement("strong"), { textContent: identity }),
    Object.assign(document.createElement("span"), {
      textContent: `x ${xName} · ${formatInterval(datum.genomicXStart, datum.genomicXEnd)}`,
    }),
    Object.assign(document.createElement("span"), {
      textContent: `y ${yName} · ${formatInterval(datum.genomicYStart, datum.genomicYEnd)}`,
    }),
  ];
  const showBase = datum.quality === "exact"
    && exactVisualization === "bases"
    && selectedColorMode() === "similarity"
    && datum.xBase !== undefined
    && datum.xBase !== null;
  if (showBase) {
    lines.push(Object.assign(document.createElement("span"), {
      textContent: `Base ${datum.xBase}`,
    }));
  }
  hoverCard.replaceChildren(...lines);
  const baseSummary = showBase ? `; Base ${datum.xBase}` : "";
  plotSummary.textContent = `${identity}; x ${xName} · ${formatInterval(datum.genomicXStart, datum.genomicXEnd)}; y ${yName} · ${formatInterval(datum.genomicYStart, datum.genomicYEnd)}${baseSummary}.`;
  hoverCard.hidden = false;
  const frame = hoverCard.parentElement?.getBoundingClientRect();
  if (frame) {
    const maximumLeft = Math.max(8, frame.width - hoverCard.offsetWidth - 8);
    const maximumTop = Math.max(8, frame.height - hoverCard.offsetHeight - 8);
    hoverCard.style.left = `${Math.min(maximumLeft, Math.max(8, event.clientX - frame.left + 14))}px`;
    hoverCard.style.top = `${Math.min(maximumTop, Math.max(8, event.clientY - frame.top + 14))}px`;
  }
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
  if (comparisonReady) {
    post({
      type: "update-refinement-policy",
      generation,
      displayMinimum: Math.round(heatmapRange.minimum * 100),
    });
  }
  updateHeatmapAppearance(true);
}

function updateHeatmapAppearance(deferGrid = false): void {
  const palette = selectedHeatmapPalette();
  const colorCount = selectedHeatmapColorCount();
  const colors = activeHeatmapColors(palette, colorCount);
  const darkBackground = backgroundButtons.some(
    (button) => button.dataset.backgroundMode === "black" && button.getAttribute("aria-pressed") === "true",
  );
  renderer.setHeatmapPalette(palette, colorCount, colors);
  renderer.setDarkBackground(darkBackground);
  if (deferGrid) queueGridAppearanceUpdate();
  else updateGridAppearance();
  plotFrame.classList.toggle("dark-background", darkBackground);
  heatmapGradientElement.style.background = heatmapGradient(
    palette,
    heatmapRange,
    darkBackground,
    colorCount,
    colors,
  );
}

function selectedHeatmapPalette(): HeatmapPalette {
  const selected = heatmapPaletteSelect.value;
  return isPaletteId(selected)
    ? selected
    : DEFAULT_HEATMAP_PALETTE;
}

function selectedHeatmapColorCount(): number {
  const palette = selectedHeatmapPalette();
  const selected = Number(heatmapColorCountInput.value);
  return paletteColorCounts(palette).includes(selected)
    ? selected
    : paletteDefaultColorCount(palette);
}

function populatePaletteControls(): void {
  heatmapPaletteSelect.replaceChildren(...PALETTE_GROUPS.map((group) => {
    const element = document.createElement("optgroup");
    element.label = group.label;
    element.append(...group.paletteIds.map((palette) => Object.assign(document.createElement("option"), {
      value: palette,
      textContent: palette,
    })));
    return element;
  }));
  heatmapPaletteSelect.value = DEFAULT_HEATMAP_PALETTE;
  updatePaletteColorCountControl(DEFAULT_HEATMAP_PALETTE, DEFAULT_HEATMAP_COLOR_COUNT);
  paletteReversed = DEFAULT_PALETTE_REVERSED;
  updatePaletteDirectionControl();
  renderPaletteSwatches();
}

function updatePaletteColorCountControl(
  palette: HeatmapPalette,
  preferred = Number(heatmapColorCountInput.value),
): void {
  const counts = paletteColorCounts(palette);
  heatmapColorCountInput.min = String(counts[0] ?? 3);
  heatmapColorCountInput.max = String(counts.at(-1) ?? 12);
  heatmapColorCountInput.value = String(
    counts.includes(preferred) ? preferred : paletteDefaultColorCount(palette),
  );
}

function paletteOverrideKey(palette: HeatmapPalette, colorCount: number): string {
  return `${palette}:${colorCount}`;
}

function canonicalHeatmapColors(
  palette = selectedHeatmapPalette(),
  colorCount = selectedHeatmapColorCount(),
): string[] {
  const override = paletteColorOverrides.get(paletteOverrideKey(palette, colorCount));
  return override ? [...override] : [...paletteColors(palette, colorCount)];
}

function activeHeatmapColors(
  palette = selectedHeatmapPalette(),
  colorCount = selectedHeatmapColorCount(),
): string[] {
  const colors = canonicalHeatmapColors(palette, colorCount);
  return paletteReversed ? colors.reverse() : colors;
}

function updatePaletteDirectionControl(): void {
  paletteFlipButton.setAttribute("aria-pressed", String(paletteReversed));
  paletteFlipButton.setAttribute(
    "aria-label",
    paletteReversed ? "Flip palette to its canonical direction" : "Flip palette to its reverse direction",
  );
  paletteFlipButton.title = paletteReversed
    ? "Palette is reversed; click for canonical direction"
    : "Palette is canonical; click to reverse direction";
}

function renderPaletteSwatches(): void {
  const colors = activeHeatmapColors();
  paletteSwatches.replaceChildren(...colors.map((color, index) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "palette-swatch";
    swatch.style.background = color;
    swatch.dataset.paletteColorIndex = String(index);
    swatch.setAttribute("aria-label", `Edit palette color ${index + 1}, ${color}`);
    swatch.setAttribute("aria-pressed", "false");
    swatch.title = `Color ${index + 1}: ${color}`;
    swatch.addEventListener("click", () => openPaletteColorEditor(index, swatch));
    return swatch;
  }));
}

function openPaletteColorEditor(index: number, invoker: HTMLButtonElement): void {
  const colors = activeHeatmapColors();
  const color = colors[index];
  if (!color) return;
  paletteColorInvoker = invoker;
  activePaletteColorIndex = index;
  paletteColorEditorTitle.textContent = `Edit color ${index + 1} of ${colors.length}`;
  paletteColorWheel.value = color;
  paletteColorHex.value = color;
  paletteColorHex.setAttribute("aria-invalid", "false");
  paletteColorMessage.textContent = "Changes update the plot, grid, and exported legend.";
  updateSwatchPressedState();
  paletteColorEditor.hidden = false;
  if (!paletteColorEditor.open) {
    if (typeof paletteColorEditor.showModal === "function") paletteColorEditor.showModal();
    else paletteColorEditor.setAttribute("open", "");
  }
  paletteColorHex.focus();
  paletteColorHex.select();
}

function closePaletteColorEditor(restoreFocus = true): void {
  const invoker = paletteColorInvoker;
  if (paletteColorEditor.open && typeof paletteColorEditor.close === "function") {
    paletteColorEditor.close();
  } else {
    paletteColorEditor.removeAttribute("open");
  }
  paletteColorEditor.hidden = true;
  paletteColorInvoker = null;
  activePaletteColorIndex = null;
  updateSwatchPressedState();
  if (restoreFocus && invoker?.isConnected) invoker.focus();
}

function updateSwatchPressedState(): void {
  for (const swatch of paletteSwatches.querySelectorAll<HTMLButtonElement>(".palette-swatch")) {
    swatch.setAttribute(
      "aria-pressed",
      String(Number(swatch.dataset.paletteColorIndex) === activePaletteColorIndex),
    );
  }
}

function applyPaletteColor(color: string, syncHex: boolean, deferGrid: boolean): void {
  if (activePaletteColorIndex === null) return;
  const normalized = parseHexColor(color);
  if (!normalized) return;
  const palette = selectedHeatmapPalette();
  const colorCount = selectedHeatmapColorCount();
  const canonical = canonicalHeatmapColors(palette, colorCount);
  const canonicalIndex = paletteReversed
    ? colorCount - 1 - activePaletteColorIndex
    : activePaletteColorIndex;
  canonical[canonicalIndex] = normalized;
  const defaults = paletteColors(palette, colorCount);
  const key = paletteOverrideKey(palette, colorCount);
  if (canonical.every((value, index) => value === defaults[index])) paletteColorOverrides.delete(key);
  else paletteColorOverrides.set(key, canonical);
  paletteColorWheel.value = normalized;
  if (syncHex) paletteColorHex.value = normalized;
  paletteColorHex.setAttribute("aria-invalid", "false");
  paletteColorMessage.textContent = "Changes update the plot, grid, and exported legend.";
  const swatch = paletteSwatches.querySelector<HTMLButtonElement>(
    `[data-palette-color-index="${activePaletteColorIndex}"]`,
  );
  if (swatch) {
    swatch.style.background = normalized;
    swatch.title = `Color ${activePaletteColorIndex + 1}: ${normalized}`;
    swatch.setAttribute("aria-label", `Edit palette color ${activePaletteColorIndex + 1}, ${normalized}`);
  }
  updateHeatmapAppearance(deferGrid);
}

function resetActivePaletteColor(): void {
  if (activePaletteColorIndex === null) return;
  const palette = selectedHeatmapPalette();
  const colorCount = selectedHeatmapColorCount();
  const defaults = paletteColors(palette, colorCount);
  const canonicalIndex = paletteReversed
    ? colorCount - 1 - activePaletteColorIndex
    : activePaletteColorIndex;
  const defaultColor = defaults[canonicalIndex];
  if (defaultColor) applyPaletteColor(defaultColor, true, false);
}

function restorePaletteEditorColor(): void {
  if (activePaletteColorIndex === null) return;
  const color = activeHeatmapColors()[activePaletteColorIndex];
  if (!color) return;
  paletteColorWheel.value = color;
  paletteColorHex.value = color;
  paletteColorHex.setAttribute("aria-invalid", "false");
  paletteColorMessage.textContent = "Changes update the plot, grid, and exported legend.";
}

function parseHexColor(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const withHash = normalized.startsWith("#") ? normalized : `#${normalized}`;
  return /^#[0-9a-f]{6}$/.test(withHash) ? withHash : null;
}

function setColorMode(mode: "similarity" | "direction"): void {
  renderer.setColorMode(mode);
  for (const peer of document.querySelectorAll<HTMLButtonElement>("[data-color-mode]")) {
    peer.setAttribute("aria-pressed", String(peer.dataset.colorMode === mode));
  }
  updateGridAppearance();
  if (activeParameters && currentMeasurement === "kmer") {
    updateScientificProvenance(activeConfigurations, activeParameters.k);
  }
  updateExactModeUi();
}

function setExactVisualization(mode: ExactVisualizationMode): void {
  exactVisualization = mode;
  renderer.setExactVisualizationMode(mode);
  if (activeParameters && currentMeasurement === "kmer") {
    updateScientificProvenance(activeConfigurations, activeParameters.k);
  }
  updateExactModeUi();
}

function updateExactModeUi(): void {
  const active = plotMode !== "grid" && currentMeasurement === "kmer";
  const colorMode = selectedColorMode();
  renderer.setExactVisualizationMode(exactVisualization);
  exactModeControls.hidden = !active;
  exactModeBanner.hidden = !active;
  exactBaseLegend.hidden = !active || exactVisualization !== "bases" || colorMode === "direction";
  for (const button of exactViewButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.exactView === exactVisualization));
  }
  exactModeBanner.textContent = exactModeBannerText(
    Number(activeParameters?.k ?? kmerInput.value),
    exactGeometry,
    exactVisualization,
    colorMode,
  );
}

function selectedColorMode(): "similarity" | "direction" {
  return document.querySelector<HTMLButtonElement>('[data-color-mode][aria-pressed="true"]')
    ?.dataset.colorMode === "direction" ? "direction" : "similarity";
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
  if (plotMode === "grid") {
    plotResolutionNote.textContent = `${GRID_OVERVIEW_RESOLUTION.toLocaleString()} × ${GRID_OVERVIEW_RESOLUTION.toLocaleString()} cells per grid overview; open a cell for zoom refinement`;
    updatePlotWindowSize();
    sketchRetentionNote.textContent = `${Number(previewRegisterSelect.value).toLocaleString()} quick-view registers per grid cell; detailed accuracy applies after opening a cell`;
    return;
  }
  const resolution = Number(resolutionSelect.value);
  plotResolutionNote.textContent = `${(resolution * resolution).toLocaleString()} similarity cells before zoom refinement`;
  updatePlotWindowSize();
  const selection = selectedSingleComparison();
  const x = sequences.find((sequence) => sequence.index === selection?.xIndex);
  const y = sequences.find((sequence) => sequence.index === selection?.yIndex);
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

function updatePlotWindowSize(): void {
  if (plotMode === "grid") {
    plotWindowSize.value = "Varies by grid plot";
    plotWindowSizeNote.textContent = "Open a grid plot to see its current genomic span per matrix cell";
    return;
  }
  const selection = selectedSingleComparison();
  const x = sequences.find((sequence) => sequence.index === selection?.xIndex);
  const y = sequences.find((sequence) => sequence.index === selection?.yIndex);
  if (!selection || !x || !y) {
    plotWindowSize.value = "—";
    plotWindowSizeNote.textContent = "Available after sequence selection";
    return;
  }
  const domainLength = Math.max(x.length, y.length);
  const baseResolution = Math.min(
    Number(resolutionSelect.value),
    Math.max(1, domainLength),
  );
  const currentResolution = activeParameters
    && activeParameters.xIndex === selection.xIndex
    && activeParameters.yIndex === selection.yIndex
    && activeParameters.resolution === baseResolution
    && pendingView
    ? requestedResolution(pendingView)
    : baseResolution;
  plotWindowSize.value = formatPlotWindowSize(domainLength, currentResolution);
  plotWindowSizeNote.textContent = currentResolution > baseResolution
    ? `${currentResolution.toLocaleString()} cells per axis at the current zoom level`
    : "Genomic interval represented by each cell at the full-plot resolution";
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
  plotFrame.classList.toggle("is-loading", loading);
  if (loading) cursorGuideController.hide();
  if (loading) dnaLoader.start();
  else dnaLoader.stop();
}

function updateCursorGuideControlState(): void {
  const disabled = !cursorGuidesEnabled.checked;
  cursorGuideGeometry.disabled = disabled;
  cursorGuideStyle.disabled = disabled;
}

function updateMemory(): void {
  const rendererBytes = renderer.estimatedByteBreakdown();
  const gridBytes = estimatedGridBytes();
  const retainedBundledOverviewBytes = activeBundledExample?.artifact.tiles.reduce(
    (total, tile) => total
      + tile.identity.byteLength
      + tile.direction.byteLength
      + tile.directionSupport.byteLength,
    0,
  ) ?? 0;
  const usage: ResourceUsage = {
    wasm: wasmBytes,
    jsTiles: rendererBytes.jsTiles + gridBytes + retainedBundledOverviewBytes,
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
  cancelExampleLoad();
  cancelPendingDetailedExport(new Error("Export cancelled because the session was cleared."));
  window.clearTimeout(prepareTimer);
  window.clearTimeout(detailTimer);
  window.clearTimeout(featureTrackTimer);
  window.clearTimeout(gridPrepareTimer);
  generation += 1;
  tileRequestId += 1;
  featureTrackRequestId += 1;
  sequences = [];
  plotMode = "self";
  gridSelectedIndices = [];
  lastFiles = [];
  stagedFastaFiles = [];
  stagedAnnotationFiles = [];
  pendingLandingAnnotations = [];
  launchValidationPending = false;
  launchReady = false;
  launchExampleWhenReady = false;
  activeBundledExample = null;
  recoveryBundledExample = null;
  recoveryFiles = null;
  comparisonReady = false;
  currentMeasurement = "sketch";
  exactVisualization = DEFAULT_EXACT_VISUALIZATION;
  activeParameters = null;
  activeConfigurations = [];
  exportDataButton.disabled = true;
  exportImageButton.disabled = true;
  activeFeatureTrackMetadata = null;
  pendingView = null;
  featureTrackBusy = false;
  sequenceLoadPending = false;
  wasmBytes = 0;
  histogramBins = new Uint32Array(101);
  histogramTiles.clear();
  clearGrid();
  cursorGuideController.hide();
  renderer.clearTiles();
  featureTracks.clear();
  importedTracks.clear();
  setPlotLoading(false);
  closePaletteColorEditor(false);
  paletteColorOverrides.clear();
  heatmapPaletteSelect.value = DEFAULT_HEATMAP_PALETTE;
  updatePaletteColorCountControl(DEFAULT_HEATMAP_PALETTE, DEFAULT_HEATMAP_COLOR_COUNT);
  paletteReversed = DEFAULT_PALETTE_REVERSED;
  updatePaletteDirectionControl();
  renderPaletteSwatches();
  for (const button of backgroundButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.backgroundMode === "white"));
  }
  updateHeatmapAppearance();
  if (workerFailed) startWorker();
  post({ type: "clear", generation });
  fileInput.value = "";
  annotationFileInput.value = "";
  fastaSelection.textContent = "No FASTA selected";
  fastaSelection.removeAttribute("title");
  annotationSelection.textContent = "No annotations selected";
  annotationSelection.removeAttribute("title");
  dropZone.classList.remove("has-selection", "is-dragging");
  annotationDropZone.classList.remove("has-selection", "is-dragging");
  exploreButton.hidden = true;
  hideExampleProgress();
  selfSelect.replaceChildren();
  xSelect.replaceChildren();
  ySelect.replaceChildren();
  gridSizeSelect.replaceChildren();
  gridSequenceSelectors.replaceChildren();
  plotModeTabs.hidden = true;
  plotModePanels.self.hidden = false;
  plotModePanels.pairwise.hidden = true;
  plotModePanels.grid.hidden = true;
  plotShell.hidden = false;
  plotGridView.hidden = true;
  featureTrackControls.hidden = false;
  plotActions.hidden = false;
  histogramCanvas.hidden = false;
  renderer.setExactVisualizationMode(exactVisualization);
  setColorMode("similarity");
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
  const launchFailure = !landing.hidden;
  workerFailed = true;
  cancelPendingDetailedExport(new Error(message));
  comparisonReady = false;
  exportDataButton.disabled = true;
  exportImageButton.disabled = true;
  featureTrackBusy = false;
  worker.terminate();
  setPlotLoading(false);
  if (launchFailure) {
    launchValidationPending = false;
    launchReady = false;
    exploreButton.hidden = true;
    fastaSelection.textContent = activeBundledExample
      ? "Unable to open the precomputed overview · retry the compute engine"
      : "Unable to validate this FASTA · choose it again to retry";
    dropZone.classList.toggle("has-selection", activeBundledExample !== null);
  }
  showError(launchFailure
    ? activeBundledExample
      ? `${message} Restart the compute engine to retry the included overview.`
      : `${message} Choose the FASTA files again to retry.`
    : `${message} Restart the compute engine to reload the selected FASTA files.`);
  retryEngineButton.hidden = launchFailure && activeBundledExample === null;
}

function restartEngine(): void {
  cancelPendingDetailedExport(new Error("Export cancelled while the compute engine restarts."));
  if (!workerFailed) worker.terminate();
  recoveryBundledExample = activeBundledExample;
  recoveryFiles = activeBundledExample === null && lastFiles.length > 0 ? [...lastFiles] : null;
  if (activeBundledExample && !landing.hidden) {
    sequenceLoadPending = true;
    launchValidationPending = true;
    launchExampleWhenReady = true;
  }
  comparisonReady = false;
  activeParameters = null;
  activeConfigurations = [];
  exportDataButton.disabled = true;
  exportImageButton.disabled = true;
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

function prepareDetailedExport(
  onProgress: (message: string, progress?: number) => void,
): Promise<void> {
  if (pendingDetailedExport) return pendingDetailedExport.promise;
  const parameters = activeParameters;
  const change = pendingView;
  if (!comparisonReady || !parameters || !change) {
    return Promise.reject(new Error("The current plot is not ready to export."));
  }
  window.clearTimeout(detailTimer);
  const resolution = requestedResolution(change);
  const exactKmerLevel = resolution === Math.floor(activeDomainLength);
  currentMeasurement = exactKmerLevel ? "kmer" : "sketch";
  updateScientificProvenance(activeConfigurations, parameters.k);
  updateExactModeUi();
  renderer.setActiveResolution(resolution);
  const tiles = selectTiles(resolution, parameters.resolution, change.view, 256, 0);
  if (renderer.hasDetailedTileCoverage(resolution, tiles)) return Promise.resolve();
  tileRequestId += 1;
  const requestId = tileRequestId;
  const requestGeneration = generation;
  post({ type: "cancel-tiles", generation: requestGeneration, requestId });
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  pendingDetailedExport = {
    generation: requestGeneration,
    requestId,
    promise,
    resolve,
    reject,
    onProgress,
  };
  plotStatusText = "Preparing detailed export";
  status.textContent = plotStatusText;
  showProgress(plotStatusText, 0);
  onProgress(plotStatusText, 0);
  post({
    type: "request-tiles",
    generation: requestGeneration,
    requestId,
    resolution,
    mode: exactKmerLevel ? "kmer" : "sketch",
    exactGeometry,
    tiles,
    forceDetailed: true,
  });
  return promise;
}

function cancelPendingDetailedExport(error: Error): void {
  const pending = pendingDetailedExport;
  pendingDetailedExport = null;
  pending?.reject(error);
}

function currentExportBaseName(): string {
  const x = sequences.find((sequence) => sequence.index === activeParameters?.xIndex)?.selectionId ?? "x";
  const y = sequences.find((sequence) => sequence.index === activeParameters?.yIndex)?.selectionId ?? "y";
  return exportBaseName(x, y);
}

function currentNumericExportContext(): NumericExportContext | null {
  if (!activeParameters || !pendingView) return null;
  const xName = sequences.find((sequence) => sequence.index === activeParameters?.xIndex)?.name ?? "x";
  const yName = sequences.find((sequence) => sequence.index === activeParameters?.yIndex)?.name ?? "y";
  return {
    domainLength: activeDomainLength,
    baseResolution: activeParameters.resolution,
    viewport: pendingView.view,
    xName,
    yName,
  };
}

function currentExportProvenance(): ExportProvenance {
  const x = sequences.find((sequence) => sequence.index === activeParameters?.xIndex);
  const y = sequences.find((sequence) => sequence.index === activeParameters?.yIndex);
  const darkBackground = backgroundButtons.some(
    (button) => button.dataset.backgroundMode === "black" && button.getAttribute("aria-pressed") === "true",
  );
  const exactK = activeParameters?.k ?? Number(kmerInput.value);
  return {
    software: __APP_VERSION__,
    exportedAt: new Date().toISOString(),
    method: "ANI_c=C^(1/k), the historical containment-derived ModDotPlot display score; exact complete distinct canonical k-mer-set containment is the validation oracle, not alignment-derived ANI_m.",
    schedulerPolicyVersion: REFINEMENT_POLICY_VERSION,
    comparison: activeParameters,
    configurations: currentMeasurement === "kmer"
      ? [{
          mode: "exact-canonical-kmer",
          k: exactK,
          geometry: exactGeometry,
          identityScale: 10_000,
          missingIdentity: 65_535,
          digest: exactConfigDigest(exactK, exactGeometry),
        }]
      : activeConfigurations,
    display: {
      measurement: currentMeasurement,
      colorMode: selectedColorMode(),
      exactVisualization: currentMeasurement === "kmer" ? exactVisualization : null,
      exactGeometry: currentMeasurement === "kmer" ? exactGeometry : null,
      palette: selectedHeatmapPalette(),
      paletteColorCount: selectedHeatmapColorCount(),
      paletteReversed,
      paletteColors: activeHeatmapColors(),
      heatmapRange,
      background: darkBackground ? "black" : "white",
    },
    viewport: pendingView?.view ?? null,
    sequences: { x: x ?? null, y: y ?? null },
  };
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
      textContent: `ModDotPlot Browser cannot start: ${message}`,
    }));
    throw error;
  }
}

function updateScientificProvenance(
  configurations: import("./protocol").ScientificConfigMetadata[],
  k: number,
): void {
  if (currentMeasurement === "kmer") {
    const visualization = selectedColorMode() === "direction"
      ? "direction"
      : exactVisualization === "bases"
        ? "Bases"
        : "identity";
    scientificProvenance.textContent = `Exact canonical ${k}-mer mode · ${exactGeometryLabel(exactGeometry)} · ${visualization} · software ${__APP_VERSION__}`;
    scientificProvenance.title = [
      `software=${__APP_VERSION__}`,
      "mode=exact-canonical-kmer",
      `digest=${exactConfigDigest(k, exactGeometry)}`,
      `k=${k}`,
      "resolution=1 bp/cell",
      `geometry=${exactGeometry}`,
      `visualization=${exactVisualization}`,
      `color-mode=${selectedColorMode()}`,
      "estimator=none",
    ].join("\n");
    return;
  }
  if (configurations.length === 0) {
    scientificProvenance.textContent = `Scientific configuration pending · software ${__APP_VERSION__}`;
    scientificProvenance.title = "Sketch estimator metadata will appear when preparation completes.";
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
    `identity-scale=${selected.identityScale}`,
    `missing=${selected.missingIdentity}`,
  ].join("\n");
}
