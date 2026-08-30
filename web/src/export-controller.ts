import type { AxisOverlay } from "./axes";
import { createCompositeExportScene, renderCompositeExport, type ImageExportFormat } from "./composite-export";
import {
  createNumericExport,
  downloadBlob,
  embedPngProvenance,
  type DataExportFormat,
  type ExportProvenance,
  type NumericExportContext,
} from "./export";
import type { DotplotRenderer } from "./renderer";

type ExportKind = "data" | "image";

interface ExportControllerOptions {
  dataButton: HTMLButtonElement;
  imageButton: HTMLButtonElement;
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  title: HTMLElement;
  fileName: HTMLInputElement;
  format: HTMLSelectElement;
  cancel: HTMLButtonElement;
  confirm: HTMLButtonElement;
  shell: HTMLElement;
  plotFrame: HTMLElement;
  renderer: DotplotRenderer;
  axes: AxisOverlay;
  baseName: () => string;
  provenance: () => ExportProvenance;
  numericContext: () => NumericExportContext | null;
  onError: (message: string) => void;
  canExport: () => boolean;
}

const FORMAT_OPTIONS: Record<ExportKind, Array<{ value: string; label: string }>> = {
  data: [
    { value: "bedpe", label: "BEDPE (.bedpe)" },
    { value: "csv", label: "CSV (.csv)" },
  ],
  image: [
    { value: "png", label: "PNG (.png)" },
    { value: "svg", label: "SVG (.svg)" },
    { value: "pdf", label: "PDF (.pdf)" },
  ],
};

export class ExportController {
  readonly #options: ExportControllerOptions;
  #kind: ExportKind = "data";

  constructor(options: ExportControllerOptions) {
    this.#options = options;
    options.dataButton.addEventListener("click", () => this.#open("data"));
    options.imageButton.addEventListener("click", () => this.#open("image"));
    options.cancel.addEventListener("click", () => options.dialog.close());
    options.format.addEventListener("change", () => this.#updateExtension());
    options.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#save();
    });
  }

  #open(kind: ExportKind): void {
    if (!this.#options.canExport()) return;
    this.#kind = kind;
    this.#options.title.textContent = kind === "data" ? "Save plot data" : "Save plot image";
    this.#options.format.replaceChildren(...FORMAT_OPTIONS[kind].map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    }));
    const defaultFormat = kind === "data" ? "bedpe" : "png";
    this.#options.format.value = defaultFormat;
    this.#options.fileName.value = `${this.#options.baseName()}.${defaultFormat}`;
    this.#options.dialog.showModal();
    this.#options.fileName.select();
  }

  async #save(): Promise<void> {
    const button = this.#kind === "data" ? this.#options.dataButton : this.#options.imageButton;
    this.#options.confirm.disabled = true;
    button.disabled = true;
    try {
      const format = this.#options.format.value;
      const fileName = withExtension(this.#options.fileName.value, format, this.#options.baseName());
      const provenance = this.#options.provenance();
      let output: Blob;
      if (this.#kind === "data") {
        const context = this.#options.numericContext();
        const tiles = this.#options.renderer.exportTileViews();
        if (!context || tiles.length === 0) throw new Error("No rendered plot data is available to export yet.");
        output = createNumericExport(tiles, context, provenance, format as DataExportFormat);
      } else {
        await this.#options.renderer.present();
        const plot = await this.#options.renderer.exportPng(2);
        const scene = await createCompositeExportScene(
          this.#options.shell,
          this.#options.plotFrame,
          plot,
          this.#options.axes.exportGeometry(),
          provenance,
        );
        output = await renderCompositeExport(scene, format as ImageExportFormat);
        if (format === "png") output = await embedPngProvenance(output, provenance);
      }
      downloadBlob(output, fileName);
      this.#options.dialog.close();
    } catch (error: unknown) {
      this.#options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.#options.confirm.disabled = false;
      button.disabled = !this.#options.canExport();
    }
  }

  #updateExtension(): void {
    this.#options.fileName.value = withExtension(
      this.#options.fileName.value,
      this.#options.format.value,
      this.#options.baseName(),
    );
  }
}

function withExtension(value: string, extension: string, fallback: string): string {
  const trimmed = value.trim().replace(/\.(bedpe|csv|png|svg|pdf)$/i, "") || fallback;
  return `${trimmed}.${extension}`;
}
