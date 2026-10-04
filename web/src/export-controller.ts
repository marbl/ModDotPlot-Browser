import type { AxisOverlay } from "./axes";
import { createCompositeExportScene, renderCompositeExport, type ImageExportFormat } from "./composite-export";
import {
  createNumericExport,
  downloadBlob,
  embedPngProvenance,
  type ExportProvenance,
  type NumericExportContext,
} from "./export";
import type { DotplotRenderer } from "./renderer";
import { createZipArchive, type ZipEntry } from "./zip";

type ExportKind = "data" | "image";

interface ExportControllerOptions {
  dataButton: HTMLButtonElement;
  imageButton: HTMLButtonElement;
  shell: HTMLElement;
  plotFrame: HTMLElement;
  renderer: DotplotRenderer;
  axes: AxisOverlay;
  baseName: () => string;
  provenance: () => ExportProvenance;
  numericContext: () => NumericExportContext | null;
  cliConfig: () => Blob | null;
  gridCommandEntries: (onProgress: (message: string, progress?: number) => void) => Promise<readonly ZipEntry[] | null>;
  prepareDetailedExport: (onProgress: (message: string, progress?: number) => void) => Promise<void>;
  progressDialog: HTMLDialogElement;
  progressMessage: HTMLElement;
  progressBar: HTMLProgressElement;
  onError: (message: string) => void;
  canExport: () => boolean;
}

interface FormatOption {
  value: ImageExportFormat | "zip";
  label: string;
  mime: string;
}

const FORMAT_OPTIONS: Record<ExportKind, FormatOption[]> = {
  data: [
    { value: "zip", label: "ModDotPlot command package", mime: "application/zip" },
  ],
  image: [
    { value: "png", label: "PNG", mime: "image/png" },
    { value: "svg", label: "SVG", mime: "image/svg+xml" },
    { value: "pdf", label: "PDF", mime: "application/pdf" },
  ],
};

interface NativeWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface NativeFileHandle {
  name: string;
  createWritable(): Promise<NativeWritable>;
}

type NativeSavePicker = (options: {
  suggestedName: string;
  startIn: "downloads";
  excludeAcceptAllOption: boolean;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<NativeFileHandle>;

export class ExportController {
  readonly #options: ExportControllerOptions;

  constructor(options: ExportControllerOptions) {
    this.#options = options;
    options.progressDialog.addEventListener("cancel", (event) => event.preventDefault());
    options.dataButton.addEventListener("click", () => void this.#save("data"));
    options.imageButton.addEventListener("click", () => void this.#save("image"));
  }

  async #save(kind: ExportKind): Promise<void> {
    if (!this.#options.canExport()) return;
    const button = kind === "data" ? this.#options.dataButton : this.#options.imageButton;
    let format: string = kind === "data" ? "zip" : "png";
    let handle: NativeFileHandle | null = null;
    const picker = (window as unknown as { showSaveFilePicker?: NativeSavePicker }).showSaveFilePicker;
    if (picker) {
      try {
        handle = await picker.call(window, {
          suggestedName: withExtension(this.#options.baseName(), format),
          startIn: "downloads",
          excludeAcceptAllOption: true,
          types: FORMAT_OPTIONS[kind].map((option) => ({
            description: `${option.label} (.${option.value})`,
            accept: { [option.mime]: [`.${option.value}`] },
          })),
        });
        format = formatFromFileName(handle.name, FORMAT_OPTIONS[kind].map((option) => option.value), format);
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        handle = null;
      }
    }
    button.disabled = true;
    const reportProgress = (message: string, progress?: number): void => {
      this.#options.progressMessage.textContent = message;
      if (progress === undefined) this.#options.progressBar.removeAttribute("value");
      else this.#options.progressBar.value = Math.max(0, Math.min(1, progress));
      if (!this.#options.progressDialog.open) this.#options.progressDialog.showModal();
    };
    try {
      const baseName = this.#options.baseName();
      const fileName = withExtension(baseName, format);
      let output: Blob;
      if (kind === "data") {
        const gridEntries = await this.#options.gridCommandEntries(reportProgress);
        if (gridEntries) {
          reportProgress("Packaging grid BEDPE files and config");
          output = await createZipArchive(gridEntries);
        } else {
          reportProgress("Checking detailed tiles");
          await this.#options.prepareDetailedExport(reportProgress);
          reportProgress("Building data export");
          const context = this.#options.numericContext();
          const tiles = this.#options.renderer.exportTileViews(true);
          if (!context || tiles.length === 0) throw new Error("No rendered plot data is available to export yet.");
          const bedpeOutput = createNumericExport(tiles, context, this.#options.provenance(), "bedpe");
          const configOutput = this.#options.cliConfig();
          if (!configOutput) throw new Error("No active comparison is available for the ModDotPlot CLI config.");
          reportProgress("Packaging BEDPE and config");
          output = await createZipArchive([
            { name: `${baseName}.bedpe`, data: bedpeOutput },
            { name: `${baseName}.config.json`, data: configOutput },
          ]);
        }
      } else {
        reportProgress("Checking detailed tiles");
        await this.#options.prepareDetailedExport(reportProgress);
        reportProgress("Rendering image");
        const plot = await this.#options.renderer.exportPng(2);
        const scene = await createCompositeExportScene(
          this.#options.shell,
          this.#options.plotFrame,
          plot,
          this.#options.axes.exportGeometry(),
          this.#options.provenance(),
        );
        output = await renderCompositeExport(scene, format as ImageExportFormat);
        if (format === "png") output = await embedPngProvenance(output, this.#options.provenance());
      }
      reportProgress("Saving file", 1);
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(output);
        await writable.close();
      } else {
        downloadBlob(output, fileName);
      }
    } catch (error: unknown) {
      this.#options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.#options.progressDialog.open) this.#options.progressDialog.close();
      button.disabled = !this.#options.canExport();
    }
  }
}

export function formatFromFileName(
  fileName: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return extension && allowed.includes(extension) ? extension : fallback;
}

function withExtension(value: string, extension: string): string {
  const trimmed = value.trim().replace(/\.(bedpe|csv|zip|png|svg|pdf)$/i, "") || "moddotplot";
  return `${trimmed}.${extension}`;
}
