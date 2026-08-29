import { expect, test, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";

const shortFasta = ">chrShort\nACGTACGTACGTACGTACGTACGTACGTACGT\n";

async function loadFasta(page: Page, name: string, contents: string): Promise<void> {
  await page.locator("#file-input").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(contents),
  });
}

async function hoverPlotCenter(page: Page): Promise<string> {
  const canvas = page.locator("#plot-canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("plot canvas has no bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.locator("#plot-summary")).not.toHaveText("No plot position selected.");
  return page.locator("#plot-summary").textContent() as Promise<string>;
}

function hasOpaqueTrackBar(track: HTMLCanvasElement): boolean {
  const pixels = track.getContext("2d")
    ?.getImageData(0, 0, track.width, track.height).data;
  return pixels?.some((channel, index) => index % 4 === 3 && channel === 255) ?? false;
}

function reverseComplement(sequence: string): string {
  const complements: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };
  return [...sequence].reverse().map((base) => complements[base] ?? "N").join("");
}

function intervalMidpoint(summary: string, axis: "x" | "y"): number {
  const match = new RegExp(`${axis} ([\\d,]+)–([\\d,]+)`).exec(summary);
  if (!match?.[1] || !match[2]) throw new Error(`Missing ${axis} interval in ${summary}`);
  return (Number(match[1].replaceAll(",", "")) + Number(match[2].replaceAll(",", ""))) / 2;
}

function bgzfBlock(contents: string): Buffer {
  const gzip = gzipSync(Buffer.from(contents));
  const block = Buffer.alloc(gzip.byteLength + 8);
  gzip.copy(block, 0, 0, 10);
  block[3] = 0x04;
  block.writeUInt16LE(6, 10);
  block.write("BC", 12, "ascii");
  block.writeUInt16LE(2, 14);
  block.writeUInt16LE(block.byteLength - 1, 16);
  gzip.copy(block, 18, 10);
  return block;
}

test("short inputs enter exact mode without network egress", async ({ page }) => {
  const unexpectedRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname !== "127.0.0.1"
    ) {
      unexpectedRequests.push(request.url());
    }
  });

  await page.goto("/");
  const progressStyle = await page.locator("#compute-progress svg").evaluate((element) => {
    const style = getComputedStyle(element);
    const circleStyle = getComputedStyle(element.querySelector("circle")!);
    return { width: style.width, height: style.height, fill: circleStyle.fill };
  });
  expect(progressStyle).toEqual({ width: "16px", height: "16px", fill: "none" });
  await loadFasta(page, "short.fa", shortFasta);

  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator("#x-sequence option")).toHaveText("chrShort · 32 bp");
  await expect(page.locator("#scientific-provenance")).toContainText("Exact canonical 21-mer mode");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#plot-canvas")).toBeVisible();
  await expect(page.locator("#plot-loading")).toBeHidden();
  expect(unexpectedRequests).toEqual([]);
});

test("a newer load transaction wins and clear rejects stale publication", async ({ page }) => {
  await page.goto("/");
  const large = `>stale\n${"ACGT".repeat(300_000)}\n`;
  await loadFasta(page, "stale.fa", large);
  await expect(page.locator("#plot-loading")).toBeVisible();
  await expect(page.locator("#plot-loading canvas.dna-loader")).toBeVisible();
  await loadFasta(page, "current.fa", ">current\nACGTACGTACGTACGTACGTACGT\n");

  await expect(page.locator("#x-sequence option")).toHaveText("current · 24 bp", {
    timeout: 20_000,
  });
  await expect(page.locator("#x-sequence option")).toHaveCount(1);
  await page.locator("#clear-button").click();
  await expect(page.locator("#landing")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("#workspace")).toBeHidden();
});

test("keyboard navigation and WebGL context recovery remain usable", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await loadFasta(page, "short.fa", shortFasta);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });

  const canvas = page.locator("#plot-canvas");
  const initialBackingSize = await canvas.evaluate((element) => ({
    width: element.width,
    height: element.height,
  }));
  await page.setViewportSize({ width: 1_200, height: 800 });
  await expect.poll(() => canvas.evaluate((element) => ({
    width: element.width,
    height: element.height,
  }))).not.toEqual(initialBackingSize);
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("+");
  await page.keyboard.press("Home");
  await expect(canvas).toBeFocused();

  const exercised = await page.evaluate(() => {
    const target = document.querySelector<HTMLCanvasElement>("#plot-canvas");
    const gl = target?.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    window.setTimeout(() => extension.restoreContext(), 50);
    return true;
  });
  if (exercised) await page.waitForTimeout(500);
  await expect(canvas).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("a crashed compute worker can restart and reload the selected FASTA", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let injected = false;
    window.Worker = class FaultInjectingWorker extends NativeWorker {
      postMessage(message: unknown, transfer?: Transferable[]): void {
        super.postMessage(message, transfer ?? []);
        if (
          !injected
          && typeof message === "object"
          && message !== null
          && "type" in message
          && message.type === "load"
        ) {
          injected = true;
          window.setTimeout(() => {
            this.dispatchEvent(new ErrorEvent("error", { message: "Injected worker crash" }));
          }, 0);
        }
      }
    } as typeof Worker;
  });

  await page.goto("/");
  await loadFasta(page, "recover.fa", shortFasta);
  await expect(page.locator("#status")).toContainText("Injected worker crash");
  await expect(page.locator("#retry-engine")).toBeVisible();
  await page.locator("#retry-engine").click();
  await expect(page.locator("#x-sequence option")).toHaveText("chrShort · 32 bp", {
    timeout: 15_000,
  });
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#retry-engine")).toBeHidden();
});

test("refined overview tiles paint before detailed preparation completes", async ({ page }) => {
  await page.goto("/");
  await page.locator("#resolution").selectOption("500", { force: true });
  const earlyRefinedTile = page.waitForFunction(() => {
    const status = document.querySelector("#status")?.textContent ?? "";
    if (!status.includes("Building high-detail signatures")) return false;
    const histogram = document.querySelector<HTMLCanvasElement>("#identity-histogram");
    const context = histogram?.getContext("2d");
    if (!histogram || !context) return false;
    return context
      .getImageData(0, 0, histogram.width, histogram.height)
      .data.some((channel, index) => index % 4 === 3 && channel !== 0);
  }, undefined, { timeout: 30_000 });

  await loadFasta(page, "progressive.fa", `>progressive\n${"ACGT".repeat(50_000)}\n`);
  await earlyRefinedTile;
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
});

test("pairwise orientation, navigation, and reset remain coherent", async ({ page }) => {
  await page.goto("/");
  await page.locator("#resolution").selectOption("500", { force: true });
  const forward = "ACGTTGCAAGTCCTGA".repeat(1_000);
  const reverse = reverseComplement(forward);
  await loadFasta(page, "pair.fa", `>forward\n${forward}\n>reverse\n${reverse}\n`);

  await expect(page.locator("#y-sequence option")).toHaveCount(2);
  await page.locator("#y-sequence").selectOption("1");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
  await expect(page.locator("#scientific-provenance")).toContainText("verified OPH");

  const direction = page.locator('[data-color-mode="direction"]');
  await direction.click();
  await expect(direction).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-color-mode="similarity"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const canvas = page.locator("#plot-canvas");
  await canvas.focus();
  await page.keyboard.press("+");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  const zoomedXAxis = await page.locator("#x-axis-overlay").evaluate(
    (axis: HTMLCanvasElement) => axis.toDataURL(),
  );
  await page.locator("#preview-register-count").selectOption("128", { force: true });
  await page.waitForTimeout(300);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
  const rebuiltXAxis = await page.locator("#x-axis-overlay").evaluate(
    (axis: HTMLCanvasElement) => axis.toDataURL(),
  );
  expect(rebuiltXAxis).toBe(zoomedXAxis);
  await page.locator("#reset-view").click();
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
  await expect(canvas).toBeVisible();
});

test("gzip FASTA and ambiguous bases load without enabling feature imports", async ({ page }) => {
  await page.goto("/");
  const annotationDrop = await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["chr1\t0\t10\n"], "not-sequence.bed", { type: "text/plain" }));
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data });
    document.querySelector("#drop-zone")!.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(annotationDrop).toBe(true);
  await expect(page.locator("#sequence-load-dialog")).toBeVisible();
  await expect(page.locator("#sequence-load-summary")).toContainText("annotation file");
  await expect(page.locator("#landing")).toBeVisible();
  await expect(page.locator("#workspace")).toBeHidden();
  await page.locator("#sequence-load-close").click();

  await loadFasta(page, "invalid.fa", "chr1\t0\t10\n");
  await expect(page.locator("#sequence-load-dialog")).toBeVisible();
  await expect(page.locator("#sequence-load-summary")).toContainText("could not be parsed as FASTA");
  await expect(page.locator("#sequence-load-details")).toContainText("before a FASTA header");
  await expect(page.locator("#landing")).toBeVisible();
  await expect(page.locator("#workspace")).toBeHidden();
  await page.locator("#sequence-load-close").click();

  const fasta = ">ambiguous\nACGTUNRY-ACGTACGTACGTACGTACGTACGT\n";
  await page.locator("#file-input").setInputFiles({
    name: "ambiguous.fa.gz",
    mimeType: "application/gzip",
    buffer: gzipSync(Buffer.from(fasta)),
  });

  await expect(page.locator("#x-sequence option")).toHaveText("ambiguous · 33 bp");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#scientific-provenance")).toContainText("Exact canonical 21-mer mode");
  await expect(page.locator("#file-input")).not.toHaveAttribute("accept", /bed|gff|gtf/i);
});

test("BGZF multi-FASTA members load as one ordered sequence stream", async ({ page }) => {
  await page.goto("/");
  const bgzf = Buffer.concat([
    bgzfBlock(">chrA\nACGTACGT"),
    bgzfBlock("ACGT\n>chrB\n"),
    bgzfBlock("TTTTCCCC\n"),
  ]);
  await page.locator("#file-input").setInputFiles({
    name: "two-records.fa.gz",
    mimeType: "application/gzip",
    buffer: bgzf,
  });

  await expect(page.locator("#x-sequence option")).toHaveText([
    "chrA · 12 bp",
    "chrB · 8 bp",
  ]);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#sequence-load-dialog")).toBeHidden();
});

test("stacked sequence tracks pan with the plot and preserve its genomic viewport", async ({ page }) => {
  await page.goto("/");
  await page.locator("#resolution").selectOption("500", { force: true });
  await loadFasta(page, "tracks.fa", `>tracks\n${"AACGCGTTCCGG".repeat(2_000)}\n`);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });

  await expect(page.locator("#heatmap-palette")).toBeVisible();
  await expect(page.locator("details", { hasText: "Advanced options" })).toHaveCount(1);
  await page.locator(".feature-track-controls summary").click();
  await expect(page.getByRole("group", { name: "GC percent tracks" })).toContainText("GC%");
  await expect(page.getByRole("group", { name: "CpG observed expected tracks" })).toContainText("CpG O/E");
  await expect(page.locator("#gc-track-x-panel")).toBeHidden();
  await expect(page.locator("#gc-track-y-panel")).toBeHidden();

  const canvas = page.locator("#plot-canvas");
  await canvas.focus();
  await page.keyboard.press("+");
  await page.keyboard.press("ArrowRight");
  const positionBeforeTracks = await hoverPlotCenter(page);

  await page.locator("#gc-track-both").check();
  await expect(page.locator("#gc-track-x")).toBeChecked();
  await expect(page.locator("#gc-track-y")).toBeChecked();
  await page.locator("#gc-track-x").uncheck();
  await expect(page.locator("#gc-track-both")).toHaveJSProperty("indeterminate", true);
  await page.locator("#gc-track-both").check();
  await expect(page.locator("#gc-track-x")).toBeChecked();
  await expect(page.locator("#gc-track-y")).toBeChecked();
  await page.locator("#cpg-track-both").check();
  await expect(page.locator("#cpg-track-x")).toBeChecked();
  await expect(page.locator("#cpg-track-y")).toBeChecked();
  await expect(page.locator("#gc-track-x-panel")).toBeVisible();
  await expect(page.locator("#gc-track-y-panel")).toBeVisible();
  await expect(page.locator("#cpg-track-x-panel")).toBeVisible();
  await expect(page.locator("#cpg-track-y-panel")).toBeVisible();
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect.poll(() => page.locator("#gc-track-x-canvas").evaluate((track: HTMLCanvasElement) => {
    const context = track.getContext("2d");
    return context?.getImageData(0, 0, track.width, track.height).data.some(
      (channel, index, pixels) => index % 4 === 0
        && channel <= 24
        && pixels[index + 3] === 255,
    ) ?? false;
  })).toBe(true);
  const gcBounds = await page.locator("#gc-track-x-canvas").boundingBox();
  if (!gcBounds) throw new Error("GC track has no bounds");
  await page.mouse.move(gcBounds.x + gcBounds.width / 2, gcBounds.y + gcBounds.height / 2);
  await expect(page.locator("#track-hover-card")).toBeVisible();
  await expect(page.locator("#track-hover-card")).toContainText("GC%");
  const gcPanelBounds = await page.locator("#gc-track-x-panel").boundingBox();
  const cpgPanelBounds = await page.locator("#cpg-track-x-panel").boundingBox();
  if (!gcPanelBounds || !cpgPanelBounds) throw new Error("computed tracks have no bounds");
  await page.mouse.move(gcPanelBounds.x + gcPanelBounds.width / 2, gcPanelBounds.y + gcPanelBounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(220);
  await expect(page.locator(".track-drag-ghost")).toBeVisible();
  await page.mouse.move(cpgPanelBounds.x + cpgPanelBounds.width / 2, cpgPanelBounds.y + cpgPanelBounds.height / 4);
  await page.mouse.up();
  await expect(page.locator(".track-drag-ghost")).toHaveCount(0);
  await expect(page.locator("#gc-track-x-panel")).not.toHaveClass(/is-track-drag-source/);
  await expect(page.locator("#gc-track-x-panel")).toHaveCSS("opacity", "1");

  const positionAfterTracks = await hoverPlotCenter(page);
  expect(intervalMidpoint(positionAfterTracks, "x")).toBeCloseTo(intervalMidpoint(positionBeforeTracks, "x"), -2);
  expect(intervalMidpoint(positionAfterTracks, "y")).toBeCloseTo(intervalMidpoint(positionBeforeTracks, "y"), -2);

  await canvas.focus();
  for (let index = 0; index < 6; index += 1) await page.keyboard.press("+");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect.poll(() => page.locator("#gc-track-x-canvas").evaluate(hasOpaqueTrackBar)).toBe(true);
  const pannedFromCache = await canvas.evaluate((target) => {
    const track = document.querySelector<HTMLCanvasElement>("#gc-track-x-canvas")!;
    const before = track.toDataURL();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const after = track.toDataURL();
    return { changed: before !== after, hasBar: hasOpaqueTrackBar(track) };

    function hasOpaqueTrackBar(trackCanvas: HTMLCanvasElement): boolean {
      const pixels = trackCanvas.getContext("2d")
        ?.getImageData(0, 0, trackCanvas.width, trackCanvas.height).data;
      return pixels?.some((channel, index) => index % 4 === 3 && channel === 255) ?? false;
    }
  });
  expect(pannedFromCache).toEqual({ changed: true, hasBar: true });
  const staleTrackHasBar = await canvas.evaluate((target) => {
    for (let index = 0; index < 20; index += 1) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    }
    const track = document.querySelector<HTMLCanvasElement>("#gc-track-x-canvas")!;
    const pixels = track.getContext("2d")
      ?.getImageData(0, 0, track.width, track.height).data;
    return pixels?.some((channel, index) => index % 4 === 3 && channel === 255) ?? false;
  });
  expect(staleTrackHasBar).toBe(false);
  await expect.poll(() => page.locator("#gc-track-x-canvas").evaluate(hasOpaqueTrackBar)).toBe(true);

  const layout = await page.evaluate(() => {
    const plot = document.querySelector("#plot-frame")!.getBoundingClientRect();
    const xTrack = document.querySelector("#gc-track-x-panel")!.getBoundingClientRect();
    const yTrack = document.querySelector("#gc-track-y-panel")!.getBoundingClientRect();
    const xAxis = document.querySelector(".axis-panel-x")!.getBoundingClientRect();
    const yAxis = document.querySelector(".axis-panel-y")!.getBoundingClientRect();
    const yTrackLabelElement = document.querySelector<HTMLElement>("#gc-track-y-panel .feature-track-name")!;
    const yTrackLabel = yTrackLabelElement.getBoundingClientRect();
    const yTrackPanel = document.querySelector("#gc-track-y-panel")!.getBoundingClientRect();
    const plotColumn = document.querySelector("#plot-column")!.getBoundingClientRect();
    const plotShell = document.querySelector("#plot-shell")!.getBoundingClientRect();
    const xLabel = document.querySelector("#x-sequence-label")!.getBoundingClientRect();
    const yLabel = document.querySelector("#y-sequence-label")!.getBoundingClientRect();
    return {
      plotWidth: plot.width,
      plotHeight: plot.height,
      xTrackHeight: xTrack.height,
      yTrackWidth: yTrack.width,
      xStackHeight: document.querySelector(".feature-track-stack-x")!.getBoundingClientRect().height,
      yStackWidth: document.querySelector(".feature-track-stack-y")!.getBoundingClientRect().width,
      xTrackTop: xTrack.top,
      plotTop: plot.top,
      xAxisTop: xAxis.top,
      xAxisBottom: xAxis.bottom,
      xTrackBottom: xTrack.bottom,
      yAxisRight: yAxis.right,
      yAxisWidth: yAxis.width,
      yTrackLeft: yTrack.left,
      yTrackRight: yTrack.right,
      plotLeft: plot.left,
      xLabelTop: xLabel.top,
      xLabelBottom: xLabel.bottom,
      plotBottom: plot.bottom,
      yLabelLeft: yLabel.left,
      plotRight: plot.right,
      yTrackLabelBottomGap: yTrackPanel.bottom - yTrackLabel.bottom,
      yTrackLabelTransform: getComputedStyle(yTrackLabelElement).transform,
      shellLeftGap: plotShell.left - plotColumn.left,
      shellRightGap: plotColumn.right - plotShell.right,
      statusInsideControls: document.querySelector(".controls")!.contains(document.querySelector("#status")),
      memoryInsideControls: document.querySelector(".controls")!.contains(document.querySelector("#memory-usage")),
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.plotWidth).toBeCloseTo(layout.plotHeight, 0);
  expect(layout.xTrackHeight).toBeCloseTo(28, 0);
  expect(layout.yTrackWidth).toBeCloseTo(28, 0);
  expect(layout.xStackHeight).toBeCloseTo(56, 0);
  expect(layout.yStackWidth).toBeCloseTo(56, 0);
  expect(layout.xAxisBottom).toBeLessThanOrEqual(layout.xTrackTop + 1);
  expect(layout.xTrackBottom).toBeLessThanOrEqual(layout.plotTop + 1);
  expect(layout.yAxisRight).toBeLessThanOrEqual(layout.yTrackLeft + 1);
  expect(layout.yAxisWidth).toBeLessThanOrEqual(42);
  expect(layout.yTrackRight).toBeCloseTo(layout.plotLeft, 0);
  expect(layout.xLabelTop).toBeGreaterThanOrEqual(layout.plotBottom - 1);
  expect(layout.yLabelLeft).toBeGreaterThanOrEqual(layout.plotRight - 1);
  expect(layout.yTrackLabelBottomGap).toBeLessThanOrEqual(4.1);
  expect(layout.yTrackLabelTransform).not.toBe("none");
  expect(layout.shellLeftGap).toBeCloseTo(layout.shellRightGap, 0);
  expect(layout.statusInsideControls).toBe(true);
  expect(layout.memoryInsideControls).toBe(true);
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

test("BED and GFF tracks import, follow their sequence, and disable by dragging away", async ({ page }) => {
  await page.goto("/");
  await page.locator("#resolution").selectOption("500", { force: true });
  await loadFasta(page, "annotations.fa", `>chr1\n${"ACGT".repeat(300)}\n>chr2\n${"TGCA".repeat(300)}\n`);
  await page.locator("#y-sequence").selectOption("1");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await page.locator(".feature-track-controls summary").click();

  const dropSafety = await page.evaluate(() => {
    const axis = document.querySelector("#x-axis-overlay")!;
    const plot = document.querySelector("#plot-canvas")!;
    const data = new DataTransfer();
    data.items.add(new File(["chr1\t0\t10\n"], "dropped.bed", { type: "text/plain" }));
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data });
    axis.dispatchEvent(over);
    const highlighted = document.querySelector("#x-axis-panel")?.classList.contains("is-track-drop-target") ?? false;
    plot.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
    return { prevented: over.defaultPrevented, highlighted };
  });
  expect(dropSafety).toEqual({ prevented: true, highlighted: true });
  await expect(page.locator("#track-import-title")).toHaveText("Track not imported");
  await page.locator("#track-import-close").click();

  await page.locator("#track-file-input").setInputFiles({
    name: "colored.bed",
    mimeType: "text/plain",
    buffer: Buffer.from([
      "track name=colored",
      "chr1\t20\t180\tred feature\t0\t+\t20\t180\t220,20,30",
      "chr1\t250\t650\tblocked gene\t0\t-\t300\t600\t30,90,170\t3\t80,60,90\t0,150,310",
      "chr2\t10\t80\tother chromosome\t0\t.\t10\t80\t0,0,0",
    ].join("\n")),
  });
  await expect(page.locator("#track-import-dialog")).toBeVisible();
  await expect(page.locator("#track-import-title")).toHaveText("Choose a track axis");
  await expect(page.locator("#track-import-confirm")).toContainText("X · chr1");
  await expect(page.locator("#track-import-secondary")).toContainText("Y · chr2");
  await page.locator("#track-import-confirm").click();
  await expect(page.locator("#track-import-dialog")).toBeHidden();
  const bedRow = page.locator(".imported-track-control", { hasText: "colored" });
  await expect(bedRow).toContainText("2 displayed features");
  const bedX = bedRow.locator('input[id$="-x"]');
  const bedY = bedRow.locator('input[id$="-y"]');
  await expect(bedX).toBeChecked();
  await expect(bedY).toBeDisabled();
  const controlLayout = await bedRow.evaluate((row) => {
    const name = row.querySelector(".imported-track-control-name")!.getBoundingClientRect();
    const controls = row.querySelector(".imported-track-control-header")!.getBoundingClientRect();
    const list = document.querySelector("#imported-track-list")!.getBoundingClientRect();
    const add = document.querySelector("#add-track")!.getBoundingClientRect();
    return { nameBottom: name.bottom, controlsTop: controls.top, listBottom: list.bottom, addTop: add.top };
  });
  expect(controlLayout.nameBottom).toBeLessThanOrEqual(controlLayout.controlsTop + 1);
  expect(controlLayout.listBottom).toBeLessThanOrEqual(controlLayout.addTop + 1);
  const bedPanel = page.locator('#x-feature-track-stack .imported-feature-track-panel:not([hidden])', { hasText: "colored" });
  await expect(bedPanel).toBeVisible();
  await expect.poll(() => bedPanel.locator("canvas").evaluate(hasOpaqueTrackBar)).toBe(true);
  await expect.poll(() => bedPanel.locator("canvas").evaluate((track: HTMLCanvasElement) => {
    const pixels = track.getContext("2d")?.getImageData(0, 0, track.width, track.height).data;
    return pixels?.some((red, index) => index % 4 === 0
      && red > 180
      && (pixels[index + 1] ?? 255) < 80
      && (pixels[index + 2] ?? 255) < 80
      && pixels[index + 3] === 255) ?? false;
  })).toBe(true);
  const bedHoverBounds = await bedPanel.boundingBox();
  if (!bedHoverBounds) throw new Error("BED track has no bounds");
  await page.mouse.move(
    bedHoverBounds.x + bedHoverBounds.width * (100 / 1_200),
    bedHoverBounds.y + bedHoverBounds.height * 0.75,
  );
  await expect(page.locator("#track-hover-card")).toContainText("red feature");

  await page.locator("#track-file-input").setInputFiles({
    name: "genes.gff3.gz",
    mimeType: "application/gzip",
    buffer: gzipSync(Buffer.from([
      "##gff-version 3",
      "chr1\tTest\tgene\t701\t1100\t.\t+\t.\tID=gene1;Name=GENE1;gene_biotype=protein_coding",
      "chr1\tTest\tmRNA\t701\t1100\t.\t+\t.\tID=tx1;Parent=gene1;Name=TX1",
      "chr1\tTest\texon\t701\t760\t.\t+\t.\tID=exon1;Parent=tx1",
      "chr1\tTest\texon\t900\t1100\t.\t+\t.\tID=exon2;Parent=tx1",
      "chr1\tTest\tCDS\t720\t1050\t.\t+\t0\tID=cds1;Parent=tx1",
    ].join("\n"))),
  });
  const geneRow = page.locator(".imported-track-control", { hasText: "genes" });
  await expect(geneRow).toContainText("1 displayed feature");
  const genePanel = page.locator('#x-feature-track-stack .imported-feature-track-panel:not([hidden])', { hasText: "genes" });
  await expect.poll(() => genePanel.locator("canvas").evaluate((track: HTMLCanvasElement) => {
    const pixels = track.getContext("2d")?.getImageData(0, 0, track.width, track.height).data;
    return pixels?.some((red, index) => index % 4 === 0
      && red === 23
      && pixels[index + 1] === 63
      && pixels[index + 2] === 115
      && pixels[index + 3] === 255) ?? false;
  })).toBe(true);
  const exonThickness = await genePanel.locator("canvas").evaluate((track: HTMLCanvasElement) => {
    const pixels = track.getContext("2d")!.getImageData(0, 0, track.width, track.height).data;
    const count = (fraction: number): number => {
      const x = Math.min(track.width - 1, Math.round(track.width * fraction));
      let total = 0;
      for (let y = 0; y < track.height; y += 1) {
        if (pixels[(y * track.width + x) * 4 + 3] === 255) total += 1;
      }
      return total;
    };
    return { nonCoding: count(710 / 1_200), coding: count(730 / 1_200) };
  });
  expect(exonThickness.coding).toBeGreaterThan(exonThickness.nonCoding);
  const increaseRows = geneRow.getByRole("button", { name: "Use more feature rows" });
  for (let row = 1; row < 10; row += 1) await increaseRows.click();
  await expect(geneRow.locator("output", { hasText: "10" })).toHaveText("10");
  const decreaseRows = geneRow.getByRole("button", { name: "Use fewer feature rows" });
  for (let row = 1; row < 10; row += 1) await decreaseRows.click();
  const orderBefore = {
    bed: (await bedPanel.boundingBox())?.y ?? 0,
    gene: (await genePanel.boundingBox())?.y ?? 0,
  };
  const currentBedBounds = await bedPanel.boundingBox();
  const geneBounds = await genePanel.boundingBox();
  if (!currentBedBounds || !geneBounds) throw new Error("imported tracks have no bounds");
  const bedStartsAboveGene = currentBedBounds.y < geneBounds.y;
  const geneMidpoint = geneBounds.y + geneBounds.height / 2;
  const initialOrderSign = Math.sign(orderBefore.bed - orderBefore.gene);
  await page.mouse.move(currentBedBounds.x + currentBedBounds.width / 2, currentBedBounds.y + currentBedBounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(220);
  await expect(page.locator(".track-drag-ghost")).toBeVisible();
  await page.mouse.move(
    geneBounds.x + geneBounds.width / 2,
    geneMidpoint + (bedStartsAboveGene ? -2 : 2),
  );
  expect(Math.sign(((await bedPanel.boundingBox())?.y ?? 0) - ((await genePanel.boundingBox())?.y ?? 0)))
    .toBe(initialOrderSign);
  const crossedMidpoint = geneMidpoint + (bedStartsAboveGene ? 2 : -2);
  await page.mouse.move(geneBounds.x + geneBounds.width / 2, crossedMidpoint);
  await expect.poll(async () => Math.sign(
    ((await bedPanel.boundingBox())?.y ?? 0) - ((await genePanel.boundingBox())?.y ?? 0),
  )).toBe(-initialOrderSign);
  await page.mouse.move(geneBounds.x + geneBounds.width / 2, crossedMidpoint + (bedStartsAboveGene ? 1 : -1));
  expect(Math.sign(((await bedPanel.boundingBox())?.y ?? 0) - ((await genePanel.boundingBox())?.y ?? 0)))
    .toBe(-initialOrderSign);
  await page.mouse.up();
  await expect(page.locator(".track-drag-ghost")).toHaveCount(0);
  const orderAfter = {
    bed: (await bedPanel.boundingBox())?.y ?? 0,
    gene: (await genePanel.boundingBox())?.y ?? 0,
  };
  expect(Math.sign(orderBefore.bed - orderBefore.gene)).toBe(-Math.sign(orderAfter.bed - orderAfter.gene));

  await page.locator("#y-sequence").selectOption("0");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(bedY).toBeEnabled();
  await bedY.check();
  await expect(page.locator('#y-feature-track-stack .imported-feature-track-panel:not([hidden])', { hasText: "colored" })).toBeVisible();

  const bounds = await bedPanel.boundingBox();
  const plotBounds = await page.locator("#plot-frame").boundingBox();
  if (!bounds || !plotBounds) throw new Error("feature track has no bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(220);
  await page.mouse.move(plotBounds.x + plotBounds.width / 2, plotBounds.y + plotBounds.height / 2);
  await expect(page.locator(".track-drag-ghost.is-removing")).toBeVisible();
  const removalHatch = await page.locator(".track-drag-ghost.is-removing").evaluate((element) =>
    getComputedStyle(element, "::after").backgroundImage);
  expect(removalHatch.match(/repeating-linear-gradient/g)).toHaveLength(1);
  await expect(page.locator("body")).toHaveCSS("cursor", "grabbing");
  await page.mouse.up();
  await expect(page.locator(".track-drag-ghost")).toHaveCount(0);
  await expect(bedX).not.toBeChecked();
});

test("heatmap palette and plot background controls update without recomputation", async ({ page }) => {
  await page.goto("/");
  await loadFasta(page, "short.fa", shortFasta);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#sparse-correction")).toHaveCount(0);
  const layout = await page.evaluate(() => {
    const xAxis = document.querySelector(".axis-panel-x")!.getBoundingClientRect();
    const yAxis = document.querySelector(".axis-panel-y")!.getBoundingClientRect();
    return {
      xAxisBottom: xAxis.bottom,
      yAxisWidth: yAxis.width,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.xAxisBottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.yAxisWidth).toBeGreaterThanOrEqual(34);
  expect(layout.yAxisWidth).toBeLessThanOrEqual(42);
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);

  const gradient = page.locator("#heatmap-gradient");
  const initialGradient = await gradient.evaluate((element) => element.style.backgroundImage);
  await page.locator("#heatmap-palette").selectOption("spectral");
  const spectralGradient = await gradient.evaluate((element) => element.style.backgroundImage);
  expect(spectralGradient).not.toBe(initialGradient);

  await expect(page.locator("#heatmap-min")).toHaveAttribute("step", "0.1");
  await page.locator("#heatmap-min").evaluate((input: HTMLInputElement) => {
    input.value = "85.1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#heatmap-min-value")).toHaveText("85.1%");

  await expect(page.locator('[data-background-mode="white"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-background-mode="black"]').click();
  await expect(page.locator('[data-background-mode="black"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#plot-frame")).toHaveClass(/dark-background/);
  await expect.poll(() => gradient.evaluate((element) => element.style.backgroundImage))
    .toContain("rgb(5, 5, 6)");
  await page.locator('[data-background-mode="white"]').click();
  await expect(page.locator("#plot-frame")).not.toHaveClass(/dark-background/);
  await expect(page.locator("#status")).toContainText("Ready");
});
