import "./styles.css";
import { AxisOverlay } from "./axes";
import { selectDetailResolution, selectTiles } from "./detail";
import { formatBases, formatBytes, formatInterval } from "./format";
import {
  DEFAULT_HEATMAP_PALETTE,
  HEATMAP_PALETTES,
  addIdentitiesToHistogram,
  heatmapGradient,
  normalizeHeatmapRange,
  type HeatmapPalette,
  type HeatmapRange,
} from "./heatmap";
import { DotplotRenderer, type HoverDatum, type ViewChange } from "./renderer";
import type {
  ComparisonParameters,
  MainToWorkerMessage,
  SequenceMetadata,
  WorkerToMainMessage,
} from "./protocol";

const landing = element<HTMLElement>("landing");
const workspace = element<HTMLElement>("workspace");
const dropZone = element<HTMLButtonElement>("drop-zone");
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
const canvas = element<HTMLCanvasElement>("plot-canvas");
const xAxisCanvas = element<HTMLCanvasElement>("x-axis-overlay");
const yAxisCanvas = element<HTMLCanvasElement>("y-axis-overlay");
const progressOverlay = element<HTMLElement>("compute-progress");
const progressRing = element<SVGCircleElement>("progress-ring");
const progressValue = element<HTMLElement>("progress-value");
const histogramCanvas = element<HTMLCanvasElement>("identity-histogram");
const heatmapPaletteSelect = element<HTMLSelectElement>("heatmap-palette");
const darkBackgroundInput = element<HTMLInputElement>("dark-background");
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
let worker: Worker;
let sequences: SequenceMetadata[] = [];
let lastFiles: File[] = [];
let recoveryFiles: File[] | null = null;
let workerFailed = false;
let generation = 0;
let prepareTimer = 0;
let detailTimer = 0;
let tileRequestId = 0;
let comparisonReady = false;
let activeParameters: ComparisonParameters | null = null;
let activeDomainLength = 1;
let pendingView: ViewChange | null = null;
let currentMeasurement: "sketch" | "kmer" = "sketch";
let overviewReadyText = "Ready";
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
        status.textContent = "Ready";
        hideProgress();
      }
      break;
    case "status":
      if (status.classList.contains("error")) break;
      status.textContent = message.text;
      if (message.busy) showProgress(message.text, message.progress);
      else hideProgress();
      break;
    case "sequences":
      if (message.generation !== generation) return;
      sequences = message.sequences;
      if (sequences.length === 0) {
        showError("No sequence records were found.");
        return;
      }
      populateSelectors();
      queueComparison(0);
      break;
    case "comparison-ready":
      if (message.generation !== generation) return;
      comparisonReady = true;
      updateScientificProvenance(message.configurations, message.parameters.k);
      status.textContent = "Drawing quick overview";
      if (pendingView && requestedResolution(pendingView) > message.parameters.resolution) {
        cancelAndQueueVisibleDetail(0);
      }
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
      collectHistogram(message);
      updateMemory();
      break;
    case "complete":
      if (message.generation !== generation) return;
      wasmBytes = message.estimatedBytes;
      overviewReadyText = `Ready · ${(message.elapsedMs / 1000).toFixed(1)} s`;
      if (currentMeasurement === "sketch" && !status.classList.contains("error")) {
        status.textContent = overviewReadyText;
      }
      hideProgress();
      updateMemory();
      break;
    case "memory":
      wasmBytes = message.estimatedBytes;
      updateMemory();
      break;
    case "error":
      showError(message.message);
      break;
  }
}

startWorker();

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) loadFiles([...fileInput.files]);
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
darkBackgroundInput.addEventListener("change", updateHeatmapAppearance);
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
  if (comparisonReady) cancelAndQueueVisibleDetail(120);
});
renderer.onTileEvict((tile) => {
  post({ type: "evict-tiles", generation, tiles: [tile] });
});
updateHeatmap("midpoint");
drawHistogram();
updateParameterNotes();

function loadFiles(files: File[], remember = true): void {
  if (remember) lastFiles = [...files];
  generation += 1;
  tileRequestId += 1;
  comparisonReady = false;
  landing.hidden = true;
  workspace.hidden = false;
  clearButton.hidden = false;
  retryEngineButton.hidden = true;
  status.classList.remove("error");
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
  comparisonReady = false;
  currentMeasurement = "sketch";
  overviewReadyText = "Ready";
  activeParameters = parameters;
  pendingView = null;
  histogramBins = new Uint32Array(101);
  histogramTiles.clear();
  drawHistogram();
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
  status.classList.remove("error");
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
  status.textContent = `${computeLabel} · 0%`;
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
    heatmapOutputs[name].value = `${heatmapRange[name]}%`;
  }
  renderer.setHeatmapRange(heatmapRange.minimum, heatmapRange.midpoint, heatmapRange.maximum);
  updateHeatmapAppearance();
}

function updateHeatmapAppearance(): void {
  const palette = selectedHeatmapPalette();
  const darkBackground = darkBackgroundInput.checked;
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

function updateMemory(): void {
  const total = wasmBytes + renderer.estimatedBytes();
  memoryUsage.textContent = total > 0 ? `Memory ~${formatBytes(total)}` : "Memory —";
}

function clearSession(): void {
  window.clearTimeout(prepareTimer);
  window.clearTimeout(detailTimer);
  generation += 1;
  tileRequestId += 1;
  sequences = [];
  lastFiles = [];
  recoveryFiles = null;
  comparisonReady = false;
  currentMeasurement = "sketch";
  activeParameters = null;
  pendingView = null;
  wasmBytes = 0;
  histogramBins = new Uint32Array(101);
  histogramTiles.clear();
  renderer.clearTiles();
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
  status.textContent = message;
  status.classList.add("error");
  hideProgress();
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
  worker.terminate();
  showError(`${message} Restart the compute engine to reload the selected FASTA files.`);
  retryEngineButton.hidden = false;
}

function restartEngine(): void {
  if (!workerFailed) worker.terminate();
  recoveryFiles = lastFiles.length > 0 ? [...lastFiles] : null;
  comparisonReady = false;
  activeParameters = null;
  renderer.clearTiles();
  wasmBytes = 0;
  updateMemory();
  retryEngineButton.hidden = true;
  status.classList.remove("error");
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
