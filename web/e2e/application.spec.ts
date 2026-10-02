import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const shortFasta = ">chrShort\nACGTACGTACGTACGTACGTACGTACGTACGT\n";

function deterministicDna(length: number, seed = 17): string {
  let state = seed;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) & 0x7fff_ffff;
    return "ACGT"[(state >>> 16) & 3];
  }).join("");
}

async function stageFasta(page: Page, name: string, contents: string): Promise<void> {
  await page.locator("#file-input").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(contents),
  });
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", {
    timeout: 20_000,
  });
  await expect(page.locator("#explore-button")).toBeVisible();
}

async function exploreStagedFasta(page: Page): Promise<void> {
  await expect(page.locator("#landing")).toBeVisible();
  await expect(page.locator("#workspace")).toBeHidden();
  await page.locator("#explore-button").click();
  await expect(page.locator("#workspace")).toBeVisible();
}

async function loadFasta(page: Page, name: string, contents: string): Promise<void> {
  await stageFasta(page, name, contents);
  await exploreStagedFasta(page);
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
  const match = new RegExp(`${axis} (?:[^;]+ · )?([\\d,]+)–([\\d,]+)`).exec(summary);
  if (!match?.[1] || !match[2]) throw new Error(`Missing ${axis} interval in ${summary}`);
  return (Number(match[1].replaceAll(",", "")) + Number(match[2].replaceAll(",", ""))) / 2;
}

interface CanvasPaintBounds {
  width: number;
  height: number;
  minimumX: number;
  minimumY: number;
  maximumX: number;
  maximumY: number;
  paintedPixels: number;
}

async function canvasPaintBounds(canvas: Locator): Promise<CanvasPaintBounds> {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d");
    if (!context) throw new Error("Grid canvas has no 2D context");
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let minimumX = element.width;
    let minimumY = element.height;
    let maximumX = -1;
    let maximumY = -1;
    let paintedPixels = 0;
    for (let y = 0; y < element.height; y += 1) {
      for (let x = 0; x < element.width; x += 1) {
        const offset = (y * element.width + x) * 4;
        const distanceFromWhite = Math.abs((pixels[offset] ?? 255) - 255)
          + Math.abs((pixels[offset + 1] ?? 255) - 255)
          + Math.abs((pixels[offset + 2] ?? 255) - 255);
        if (distanceFromWhite <= 12) continue;
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
        paintedPixels += 1;
      }
    }
    return {
      width: element.width,
      height: element.height,
      minimumX,
      minimumY,
      maximumX,
      maximumY,
      paintedPixels,
    };
  });
}

function expectPaintedExtent(
  bounds: CanvasPaintBounds,
  expectedWidthFraction: number,
  expectedHeightFraction: number,
): void {
  expect(bounds.paintedPixels).toBeGreaterThan(0);
  expect(bounds.minimumX).toBeLessThanOrEqual(2);
  expect(bounds.maximumY).toBeGreaterThanOrEqual(bounds.height - 3);
  expect((bounds.maximumX + 1) / bounds.width).toBeCloseTo(expectedWidthFraction, 1);
  expect((bounds.height - bounds.minimumY) / bounds.height).toBeCloseTo(expectedHeightFraction, 1);
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

function gziBuffer(checkpoints: Array<{ compressed: number; uncompressed: number }>): Buffer {
  const bytes = Buffer.alloc(8 + checkpoints.length * 16);
  bytes.writeBigUInt64LE(BigInt(checkpoints.length), 0);
  checkpoints.forEach((checkpoint, index) => {
    bytes.writeBigUInt64LE(BigInt(checkpoint.compressed), 8 + index * 16);
    bytes.writeBigUInt64LE(BigInt(checkpoint.uncompressed), 16 + index * 16);
  });
  return bytes;
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
  await expect(page).toHaveTitle("ModDotPlot Browser");
  await expect(page.locator("#landing h1")).toHaveAccessibleName("ModDotPlot Browser");
  await expect(page.locator("#landing .landing-logo")).toHaveAttribute(
    "src",
    "/moddotplot-browser.gif",
  );
  await expect(page.locator("#landing .landing-logo-heading")).toHaveCSS("width", "575px");
  await expect(page.locator("#landing-version")).toHaveText(/^v\d/);
  await expect(page.locator(".landing-notes")).toHaveCount(0);
  await expect(page.locator("#drop-title")).toHaveText("Drop FASTA files here");
  await expect(page.locator(".drop-detail")).toHaveText(
    "or click to choose files · FASTA, gzip, and BGZF · optional fai/gzi indixes (faster loading)",
  );
  await expect(page.locator(".annotation-drop-title")).toHaveText("Drop annotation files here");
  await expect(page.locator(".annotation-drop-detail")).toContainText("BED, GFF3, or GTF");
  await expect(page.locator("#annotation-drop-zone")).toBeVisible();
  await expect(page.locator("#explore-button")).toBeHidden();
  await expect(page.locator("#example-button")).toHaveText(
    "Try ModDotPlot on an Arabidopsis thaliana genome",
  );
  await expect(page.locator("#example-button i")).toHaveText("Arabidopsis thaliana");
  await expect(page.locator('.github-link[href="https://github.com/marbl/ModDotPlot"]')).toBeVisible();
  await expect(page.locator('.github-link[href="https://github.com/marbl/ModDotPlot-Browser"]')).toBeVisible();
  await expect(page.locator(".github-link .github-icon")).toHaveCount(2);
  await expect(page.locator(".publication-warning")).toHaveText(
    "This experimental, vibe-coded WebAssembly version of ModDotPlot should not be used for publications. Please use the official ModDotPlot CLI instead.",
  );
  await expect(page.locator(".publication-warning strong em")).toHaveText(
    "should not be used for publications",
  );
  const landingVersion = await page.locator("#landing-version").textContent();
  const progressStyle = await page.locator("#compute-progress svg").evaluate((element) => {
    const style = getComputedStyle(element);
    const circleStyle = getComputedStyle(element.querySelector("circle")!);
    return { width: style.width, height: style.height, fill: circleStyle.fill };
  });
  expect(progressStyle).toEqual({ width: "16px", height: "16px", fill: "none" });
  await stageFasta(page, "short.fa", shortFasta);

  await expect(page.locator("#landing")).toBeVisible();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#plot-loading")).toBeHidden();
  await expect(page.locator("#fasta-selection")).toHaveText("short.fa ready to explore");
  await exploreStagedFasta(page);

  await expect(page.locator("#workspace")).toBeVisible();
  await expect(page.locator(".control-header h1")).toHaveText("ModDotPlot Browser");
  await expect(page.locator("#x-sequence option")).toHaveText("chrShort_short · 32 bp");
  await expect(page.locator("#scientific-provenance")).toContainText("Exact canonical 21-mer mode");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#plot-canvas")).toBeVisible();
  await expect(page.locator("#plot-loading")).toBeHidden();
  await expect(page.locator("#exact-mode-controls")).toBeVisible();
  await expect(page.locator('[data-exact-view="bases"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-exact-view="identity"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-exact-geometry]")).toHaveCount(0);
  await expect(page.locator("#show-direction")).toHaveCount(0);
  await expect(page.locator("#exact-mode-banner")).toHaveText(
    "Exact · 1 bp/cell · canonical 21-mers · full footprints · color = Base",
  );
  await expect(page.locator("#exact-state-legend")).toHaveCount(0);
  await expect(page.locator("#exact-base-legend")).toBeVisible();
  await expect(page.locator("#exact-base-legend strong")).toHaveText("Base");

  await page.locator('[data-exact-view="identity"]').click();
  await expect(page.locator("#exact-base-legend")).toBeHidden();
  await expect(page.locator("#exact-mode-banner")).toContainText("color = identity");
  await page.locator('[data-color-mode="direction"]').click();
  await expect(page.locator('[data-color-mode="direction"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#exact-base-legend")).toBeHidden();
  await expect(page.locator("#control-version")).toHaveText(landingVersion ?? "");
  expect(unexpectedRequests).toEqual([]);
});

test("Clear restores Bases with similarity coloring for a new exact session", async ({ page }) => {
  await page.goto("/");
  await loadFasta(page, "first.fa", shortFasta);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });

  await page.locator('[data-color-mode="direction"]').click();
  await expect(page.locator('[data-color-mode="direction"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#exact-mode-banner")).toContainText("color = direction");
  await expect(page.locator("#exact-base-legend")).toBeHidden();

  await page.locator("#clear-button").click();
  await expect(page.locator("#landing")).toBeVisible();
  await loadFasta(page, "second.fa", shortFasta);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });

  await expect(page.locator('[data-color-mode="similarity"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-color-mode="direction"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-exact-view="bases"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#exact-mode-banner")).toContainText("color = Base");
  await expect(page.locator("#exact-base-legend")).toBeVisible();
});

test("the bundled Arabidopsis overview reaches Ready before FASTA or annotations", async ({ page }) => {
  const examplesDirectory = new URL("../public/examples/", import.meta.url);
  const exampleFai = await readFile(new URL("Col-CEN_v1.2.fasta.fai", examplesDirectory));
  const exampleGff = await readFile(new URL("ColCEN_CEN180.gff3", examplesDirectory));
  const requestedAssets: string[] = [];
  const fastaRequests: Array<{ range: string | null }> = [];
  let releaseAnnotation = (): void => undefined;
  const annotationGate = new Promise<void>((resolve) => {
    releaseAnnotation = resolve;
  });

  await page.route(/\/examples\/Col-CEN_v1\.2\.fasta$/, async (route) => {
    requestedAssets.push("fasta");
    const range = route.request().headers().range ?? null;
    fastaRequests.push({ range });
    if (!range) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.route(/\/examples\/Col-CEN_v1\.2\.fasta\.fai$/, async (route) => {
    requestedAssets.push("fai");
    await route.fulfill({ status: 200, contentType: "text/plain", body: exampleFai });
  });
  await page.route(/\/examples\/Col-CEN_v1\.2\.Chr1\.mdp-overview-v1\.gz$/, async (route) => {
    requestedAssets.push("overview");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.continue();
  });
  await page.route(/\/examples\/ColCEN_CEN180\.gff3$/, async (route) => {
    requestedAssets.push("gff3");
    await annotationGate;
    await route.fulfill({ status: 200, contentType: "text/plain", body: exampleGff });
  });

  await page.goto("/");
  await page.locator("#example-button").click();
  await expect(page.locator("#workspace")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#landing")).toBeHidden();
  await expect(page.locator("#self-sequence option")).toHaveCount(7);
  await expect(page.locator("#self-sequence option").first())
    .toHaveText("Chr1_Col-CEN_v1.2 · 32.5 Mb");
  await expect(page.locator("#self-sequence")).toHaveValue("0");
  await expect(page.locator("#fasta-selection")).toContainText("Col-CEN_v1.2.fasta");
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore");
  await expect(page.locator("#annotation-selection")).toContainText("Loading included CEN180");
  await expect(page.locator("#status")).toHaveText(
    /^Ready · (?:precomputed|bundled overview cached)$/u,
    {
      timeout: 15_000,
    },
  );
  await expect(page.locator("#plot-loading")).toBeHidden();
  await expect(page.locator("#export-data")).toBeEnabled();
  await expect(page.locator("#export-image")).toBeEnabled();
  expect(requestedAssets).toContain("fai");
  expect(requestedAssets).toContain("overview");
  expect(requestedAssets).toContain("gff3");
  expect(fastaRequests).toEqual([]);

  const summary = await hoverPlotCenter(page);
  expect(summary).toMatch(/identity 100\.00%/u);
  expect(summary).toMatch(/x Chr1 ·/u);
  expect(summary).toMatch(/y Chr1 ·/u);
  await expect.poll(() => page.locator("#identity-histogram").evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels?.filter((channel, index) => index % 4 === 3 && channel !== 0).length ?? 0;
  })).toBeGreaterThan(0);

  const firstRangeResponse = page.waitForResponse((response) => (
    response.url().endsWith("/examples/Col-CEN_v1.2.fasta")
    && response.request().headers().range !== undefined
    && response.status() === 206
  ), { timeout: 20_000 });
  await page.locator("#self-sequence").selectOption("1");
  const rangeResponse = await firstRangeResponse;
  expect(rangeResponse.request().headers().range).toMatch(/^bytes=\d+-\d+$/u);
  expect(await rangeResponse.headerValue("content-range"))
    .toMatch(/^bytes \d+-\d+\/134282475$/u);
  expect(fastaRequests.length).toBeGreaterThan(0);
  expect(fastaRequests.every(({ range }) => /^bytes=\d+-\d+$/u.test(range ?? ""))).toBe(true);

  releaseAnnotation();
  await expect(page.locator("#annotation-selection")).toHaveText("ColCEN_CEN180.gff3 loaded", {
    timeout: 15_000,
  });
});

test("cursor guides follow the pointer and advanced controls change their appearance", async ({ page }) => {
  await page.addInitScript(() => {
    const harness = window as unknown as { __guidePrepareMessages?: number };
    harness.__guidePrepareMessages = 0;
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[]): void {
      if (typeof message === "object" && message !== null
        && (message as { type?: string }).type === "prepare") {
        harness.__guidePrepareMessages = (harness.__guidePrepareMessages ?? 0) + 1;
      }
      if (transfer === undefined) originalPostMessage.call(this, message);
      else originalPostMessage.call(this, message, transfer);
    } as typeof Worker.prototype.postMessage;
  });

  await page.goto("/");
  await loadFasta(page, "guides.fa", shortFasta);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  const prepareMessages = await page.evaluate(() =>
    (window as unknown as { __guidePrepareMessages?: number }).__guidePrepareMessages ?? 0);
  const canvas = page.locator("#plot-canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("plot canvas has no bounds");
  await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.6);

  const guides = page.locator("#cursor-guides");
  await expect(guides).toBeVisible();
  await expect(guides).toHaveAttribute("data-guide-geometry", "axes");
  await expect(guides).toHaveAttribute("data-guide-style", "dotted");
  const defaults = await guides.evaluate((element) => ({
    x: element.style.getPropertyValue("--cursor-guide-x"),
    y: element.style.getPropertyValue("--cursor-guide-y"),
    firstAngle: element.style.getPropertyValue("--cursor-guide-first-angle"),
    secondAngle: element.style.getPropertyValue("--cursor-guide-second-angle"),
    lineStyle: element.style.getPropertyValue("--cursor-guide-line-style"),
  }));
  expect(Math.abs(Number.parseFloat(defaults.x) - bounds.width * 0.4)).toBeLessThanOrEqual(2);
  expect(Math.abs(Number.parseFloat(defaults.y) - bounds.height * 0.6)).toBeLessThanOrEqual(2);
  expect(defaults.firstAngle).toBe("0deg");
  expect(defaults.secondAngle).toBe("90deg");
  expect(defaults.lineStyle).toBe("dotted");

  await page.locator(".advanced-controls summary").click();
  await expect(page.locator("#cursor-guides-enabled")).toBeChecked();
  await page.locator("#cursor-guide-geometry").selectOption("diagonals");
  await page.locator("#cursor-guide-style").selectOption("dashed");
  await expect(guides).toHaveAttribute("data-guide-geometry", "diagonals");
  await expect(guides).toHaveAttribute("data-guide-style", "dashed");
  await expect.poll(() => guides.evaluate((element) => ({
    first: element.style.getPropertyValue("--cursor-guide-first-angle"),
    second: element.style.getPropertyValue("--cursor-guide-second-angle"),
    style: element.style.getPropertyValue("--cursor-guide-line-style"),
  }))).toEqual({ first: "45deg", second: "-45deg", style: "dashed" });

  await page.locator("#cursor-guides-enabled").uncheck();
  await expect(guides).toBeHidden();
  await expect(page.locator("#cursor-guide-geometry")).toBeDisabled();
  await expect(page.locator("#cursor-guide-style")).toBeDisabled();
  await page.locator("#cursor-guides-enabled").check();
  await expect(page.locator("#cursor-guide-geometry")).toBeEnabled();
  await page.locator("#cursor-guide-style").selectOption("solid");
  await expect(guides).toHaveAttribute("data-guide-style", "solid");
  await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.6);
  await expect(guides).toBeVisible();
  await page.mouse.move(bounds.x - 10, bounds.y - 10);
  await expect(guides).toBeHidden();
  expect(await page.evaluate(() =>
    (window as unknown as { __guidePrepareMessages?: number }).__guidePrepareMessages ?? 0))
    .toBe(prepareMessages);
});

test("landing annotations stay staged until Explore opens the workspace", async ({ page }) => {
  await page.goto("/");
  await page.locator("#annotation-file-input").setInputFiles({
    name: "landing.bed",
    mimeType: "text/plain",
    buffer: Buffer.from([
      "track name=landing-track",
      "first\t1\t20\tfirst staged feature",
      "second\t2\t18\tsecond staged feature",
    ].join("\n")),
  });

  await expect(page.locator("#annotation-selection")).toHaveText("landing.bed selected");
  await expect(page.locator("#annotation-drop-zone")).toHaveClass(/has-selection/);
  await expect(page.locator("#explore-button")).toBeHidden();
  await expect(page.locator("#workspace")).toBeHidden();

  await stageFasta(page, "multi.fa", [
    `>first\n${deterministicDna(64, 3)}`,
    `>second\n${deterministicDna(64, 7)}`,
  ].join("\n"));
  await expect(page.locator("#annotation-selection")).toHaveText("landing.bed selected");
  await expect(page.locator(".imported-track-control")).toHaveCount(0);
  await exploreStagedFasta(page);

  const stagedTrack = page.locator(".imported-track-control", { hasText: "landing-track" });
  await expect(stagedTrack).toHaveCount(1, { timeout: 15_000 });
  await expect(stagedTrack).toContainText("2 matching sequences · BED · 2 displayed features");
  await expect(stagedTrack.locator('input[id$="-both"]')).toBeChecked();
});

test("Save As exports current-view BEDPE and complete PNG/SVG/PDF compositions", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "download payload inspection runs on the Chromium channels");
  await page.addInitScript(() => {
    type SaveHarness = Window & {
      __saveFormat?: string;
      __saveOptions?: { startIn?: string; types?: unknown[] };
      __numericExport?: string;
      __forcedDetailRequests?: number;
      showSaveFilePicker?: (options: {
        suggestedName: string;
        startIn?: string;
        types?: unknown[];
      }) => Promise<unknown>;
    };
    const harness = window as SaveHarness;
    harness.__forcedDetailRequests = 0;
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[]): void {
      if (typeof message === "object" && message !== null
        && (message as { type?: string }).type === "request-tiles"
        && (message as { forceDetailed?: boolean }).forceDetailed === true) {
        harness.__forcedDetailRequests = (harness.__forcedDetailRequests ?? 0) + 1;
      }
      if (transfer === undefined) originalPostMessage.call(this, message);
      else originalPostMessage.call(this, message, transfer);
    } as typeof Worker.prototype.postMessage;
    harness.showSaveFilePicker = async (options) => {
      harness.__saveOptions = { startIn: options.startIn, types: options.types };
      const requested = harness.__saveFormat;
      const name = requested
        ? options.suggestedName.replace(/\.[a-z0-9]+$/i, `.${requested}`)
        : options.suggestedName;
      const isNumeric = /\.(bedpe|csv)$/i.test(name);
      return {
        name,
        createWritable: async () => ({
          write: async (blob: Blob) => {
            if (isNumeric) {
              harness.__numericExport = await blob.text();
              return;
            }
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = name;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
          },
          close: async () => undefined,
        }),
      };
    };
  });
  await page.goto("/");
  await page.locator("#resolution").selectOption("500", { force: true });
  await page.locator("#kmer-length").fill("5", { force: true });
  await loadFasta(page, "short.fa", `>chrShort\n${deterministicDna(6_000)}\n`);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#export-data-format")).toHaveCount(0);
  await expect(page.locator("#export-image-format")).toHaveCount(0);
  await expect(page.locator("#heatmap-palette")).toHaveValue("Spectral");
  await expect(page.locator("#heatmap-color-count")).toHaveValue("11");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("min", "3");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("max", "11");
  await expect(page.locator('[data-background-mode="white"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-background-mode="black"]')).toHaveAttribute("aria-pressed", "false");

  const exportImageFit = await page.locator("#export-image").evaluate((button) => ({
    clientWidth: button.clientWidth,
    scrollWidth: button.scrollWidth,
    clientHeight: button.clientHeight,
    scrollHeight: button.scrollHeight,
  }));
  expect(exportImageFit.scrollWidth).toBeLessThanOrEqual(exportImageFit.clientWidth);
  expect(exportImageFit.scrollHeight).toBeLessThanOrEqual(exportImageFit.clientHeight);

  const configDownload = page.waitForEvent("download");
  await page.locator("#export-data").click();
  const configArtifact = await configDownload;
  expect(configArtifact.suggestedFilename()).toBe(
    "moddotplot-chrShort_short-vs-chrShort_short.config.json",
  );
  const bedpe = await page.evaluate(() =>
    (window as unknown as { __numericExport: string }).__numericExport);
  expect(bedpe).toContain("# provenance=");
  expect(bedpe).toContain("exact complete distinct canonical k-mer-set containment");
  expect(bedpe).toContain("#chrom1\tstart1\tend1\tchrom2\tstart2\tend2");
  expect(bedpe).not.toContain("quality\tconfig_digest");
  const saveOptions = await page.evaluate(() =>
    (window as unknown as { __saveOptions?: { startIn?: string; types?: unknown[] } }).__saveOptions);
  expect(saveOptions?.startIn).toBe("downloads");
  expect(saveOptions?.types).toHaveLength(2);
  const configPath = await configArtifact.path();
  if (!configPath) throw new Error("CLI config export has no temporary path");
  const cliConfig = JSON.parse(await readFile(configPath, "utf8"));
  expect(cliConfig).toMatchObject({
    fasta: ["./short.fa"],
    sequence: ["chrShort"],
    kmer: 21,
    compare_only: false,
    grid_only: false,
    palette: "Spectral_11",
    colors: expect.any(Array),
    breakpoints: expect.any(Array),
  });
  expect(cliConfig.colors).toHaveLength(11);
  expect(cliConfig.breakpoints).toHaveLength(12);
  expect(cliConfig.identity).toBe(cliConfig.breakpoints[0]);
  await expect(page.locator("#export-progress-dialog")).toBeHidden();

  await page.locator(".feature-track-controls summary").click();
  await page.locator("#gc-track-x").check();
  await page.locator("#cpg-track-y").check();
  await expect(page.locator("#gc-track-x-panel")).toBeVisible();
  await expect(page.locator("#cpg-track-y-panel")).toBeVisible();
  for (const [id, value] of [["heatmap-min", "90.2"], ["heatmap-mid", "97.1"]] as const) {
    await page.locator(`#${id}`).evaluate((input, nextValue) => {
      (input as HTMLInputElement).value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
  }
  await expect(page.locator("#heatmap-min-value")).toHaveText("90.2%");
  await expect(page.locator("#heatmap-mid-value")).toHaveText("97.1%");

  const backingSize = await page.locator("#plot-canvas").evaluate((canvas) => ({
    width: (canvas as HTMLCanvasElement).width,
    height: (canvas as HTMLCanvasElement).height,
  }));
  const forcedRequestsBeforeImage = await page.evaluate(() =>
    (window as unknown as { __forcedDetailRequests?: number }).__forcedDetailRequests ?? 0);
  await page.locator("#plot-canvas").evaluate((canvas) => {
    const state = { backingStoreMutations: 0 };
    (window as unknown as { __imageRenderState?: typeof state }).__imageRenderState = state;
    new MutationObserver((records) => {
      state.backingStoreMutations += records.length;
    }).observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
  });
  const imageDownload = page.waitForEvent("download");
  await page.locator("#export-image").click();
  const image = await imageDownload;
  await expect(page.locator("#export-progress-dialog")).toBeHidden();
  expect(await page.evaluate(() =>
    (window as unknown as { __forcedDetailRequests?: number }).__forcedDetailRequests ?? 0))
    .toBe(forcedRequestsBeforeImage);
  expect(await page.evaluate(() =>
    (window as unknown as { __imageRenderState?: { backingStoreMutations: number } })
      .__imageRenderState?.backingStoreMutations ?? -1)).toBe(0);
  if (process.env.MODDOTPLOT_PNG_QA) await image.saveAs(process.env.MODDOTPLOT_PNG_QA);
  expect(image.suggestedFilename()).toBe("moddotplot-chrShort_short-vs-chrShort_short.png");
  const imagePath = await image.path();
  if (!imagePath) throw new Error("image export has no temporary path");
  const png = await readFile(imagePath);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBeGreaterThan(backingSize.width);
  expect(png.readUInt32BE(20)).toBeGreaterThan(backingSize.height);
  expect(png.includes(Buffer.from("iTXtmoddotplot-interactive"))).toBe(true);
  expect(png.includes(Buffer.from("schedulerPolicyVersion"))).toBe(true);
  expect(png.includes(Buffer.from("configurations"))).toBe(true);
  expect(png.includes(Buffer.from("exact complete distinct canonical k-mer-set containment"))).toBe(true);

  for (const format of ["svg", "pdf"] as const) {
    await page.evaluate((selected) => {
      (window as unknown as { __saveFormat?: string }).__saveFormat = selected;
    }, format);
    const download = page.waitForEvent("download");
    await page.locator("#export-image").click();
    const result = await download;
    const qaPath = format === "svg"
      ? process.env.MODDOTPLOT_SVG_QA
      : process.env.MODDOTPLOT_PDF_QA;
    if (qaPath) await result.saveAs(qaPath);
    const resultPath = await result.path();
    if (!resultPath) throw new Error(`${format} export has no temporary path`);
    const bytes = await readFile(resultPath);
    if (format === "svg") {
      const svg = bytes.toString("utf8");
      expect(svg).toContain("<image");
      expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
      expect(svg).toContain('xlink:href="data:image/png;base64,');
      expect(svg).toContain("<text");
      expect(svg).toContain("chrShort");
      expect(svg).toContain("GC%");
      expect(svg).toContain("CpG O/E");
      expect(svg).toContain("ANI_c");
      expect(svg).not.toContain(">Viridis</text>");
      const svgInspection = await page.evaluate(async (source) => {
        const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
        const plotImage = parsed.querySelector("image");
        const embedded = plotImage?.getAttributeNS(
          "http://www.w3.org/1999/xlink",
          "href",
        ) ?? "";
        const legendText = [...parsed.querySelectorAll("text")]
          .find((element) => element.textContent === "ANI_c");
        const plotRight = Number(plotImage?.getAttribute("x") ?? 0)
          + Number(plotImage?.getAttribute("width") ?? 0);
        const legendOutsidePlot = Number(legendText?.getAttribute("x") ?? 0) > plotRight;
        const percentTicks = [...parsed.querySelectorAll("text")]
          .filter((element) => /^\d+\.\d%$/.test(element.textContent ?? ""))
          .map((element) => ({
            label: element.textContent ?? "",
            y: Number(element.getAttribute("y") ?? Number.NaN),
          }))
          .sort((left, right) => left.y - right.y);
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context?.drawImage(image, 0, 0);
        const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
        const hasColoredRasterPixel = pixels
          ? pixels.some((_, index) => index % 4 === 0
            && Math.max(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!)
              - Math.min(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!) > 40
            && pixels[index + 3]! > 0)
          : false;
        return {
          parseErrors: parsed.querySelectorAll("parsererror").length,
          embedded,
          hasColoredRasterPixel,
          legendOutsidePlot,
          percentTicks,
        };
      }, svg);
      expect(svgInspection.parseErrors).toBe(0);
      expect(svgInspection.embedded).toMatch(/^data:image\/png;base64,/);
      expect(svgInspection.hasColoredRasterPixel).toBe(true);
      expect(svgInspection.legendOutsidePlot).toBe(true);
      expect(svgInspection.percentTicks.map((tick) => tick.label)).toEqual([
        "100.0%", "98.0%", "96.1%", "94.1%", "92.2%", "90.2%",
      ]);
      expect(svgInspection.percentTicks.map((tick) => tick.y)).toEqual([
        expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
        expect.any(Number),
      ]);
      const tickGaps = svgInspection.percentTicks.slice(1).map((tick, index) =>
        tick.y - svgInspection.percentTicks[index]!.y);
      for (const gap of tickGaps.slice(1)) expect(gap).toBeCloseTo(tickGaps[0]!, 5);
      expect(svgInspection.percentTicks.some((tick) => tick.label === "97.1%")).toBe(false);
    } else {
      expect(bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.7");
      expect(bytes.includes(Buffer.from("/Subtype /Image"))).toBe(true);
      expect(bytes.includes(Buffer.from("chrShort"))).toBe(true);
      expect(bytes.includes(Buffer.from("GC%"))).toBe(true);
      expect(bytes.includes(Buffer.from("CpG O/E"))).toBe(true);
      expect(bytes.includes(Buffer.from("ANI_c"))).toBe(true);
      expect(bytes.includes(Buffer.from("Viridis"))).toBe(false);
    }
  }
});

test("exports wait for detailed visible tiles behind a blocking progress dialog", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "export payload inspection runs on the Chromium channel");
  await page.addInitScript(() => {
    const state = { contents: "", closedCount: 0 };
    (window as unknown as { __detailedSave: typeof state }).__detailedSave = state;
    (window as unknown as { showSaveFilePicker: (options: { suggestedName: string }) => Promise<unknown> })
      .showSaveFilePicker = async (options) => ({
        name: options.suggestedName.replace(/\.bedpe$/i, ".csv"),
        createWritable: async () => ({
          write: async (blob: Blob) => {
            state.contents = await blob.text();
            await new Promise((resolve) => setTimeout(resolve, 150));
          },
          close: async () => { state.closedCount += 1; },
        }),
      });
  });
  await page.goto("/");
  await page.locator("#resolution").selectOption("500", { force: true });
  await page.locator("#kmer-length").fill("5", { force: true });
  const sequence = deterministicDna(6_000);
  await loadFasta(page, "detailed.fa", `>detailed\n${sequence}\n`);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
  const configDownload = page.waitForEvent("download");
  await page.locator("#export-data").click();
  await expect(page.locator("#export-progress-dialog")).toBeVisible();
  expect(await page.locator("#export-progress-dialog").evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
  await page.waitForFunction(() =>
    (window as unknown as { __detailedSave?: { closedCount: number } }).__detailedSave?.closedCount === 1,
  { timeout: 30_000 });
  await expect(page.locator("#export-progress-dialog")).toBeHidden();
  const contents = await page.evaluate(() =>
    (window as unknown as { __detailedSave: { contents: string } }).__detailedSave.contents);
  expect(contents).toContain("x_seq_id,x_start,x_end,y_seq_id,y_start,y_end,ani_c,direction,direction_support");
  const rows = contents.split("\n").filter((row) => /^detailed,/.test(row));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.split(",").length === 9)).toBe(true);
  expect(contents).not.toContain("identity_fixed");
  expect(contents).not.toContain("config_digest");
  const configArtifact = await configDownload;
  const configPath = await configArtifact.path();
  if (!configPath) throw new Error("CLI config export has no temporary path");
  expect(JSON.parse(await readFile(configPath, "utf8")))
    .toMatchObject({ fasta: ["./detailed.fa"], sequence: ["detailed"] });
});

test("FASTA descriptions stay on axes while source-qualified IDs disambiguate selections and saves", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { suggestedName: "", contents: "", closedCount: 0 };
    (window as unknown as { __nativeSave: typeof state }).__nativeSave = state;
    (window as unknown as { showSaveFilePicker: (options: { suggestedName: string }) => Promise<unknown> })
      .showSaveFilePicker = async (options) => {
        state.suggestedName = options.suggestedName;
        return {
          name: options.suggestedName,
          createWritable: async () => ({
            write: async (blob: Blob) => {
              state.contents = await blob.text();
            },
            close: async () => { state.closedCount += 1; },
          }),
        };
      };
  });
  await page.goto("/");
  await page.locator("#file-input").setInputFiles([
    {
      name: "human.fa",
      mimeType: "text/plain",
      buffer: Buffer.from(">chr1 human chromosome one\nACGTACGTACGTACGTACGTACGT\n"),
    },
    {
      name: "gorilla.fa",
      mimeType: "text/plain",
      buffer: Buffer.from(">chr1 gorilla chromosome one\nACGTACGTACGTACGTACGTACGT\n"),
    },
  ]);
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", {
    timeout: 20_000,
  });
  await exploreStagedFasta(page);
  await page.locator("#plot-mode-pairwise").click();
  await expect(page.locator("#x-sequence option")).toHaveText([
    "chr1_human · 24 bp",
    "chr1_gorilla · 24 bp",
  ]);
  await expect(page.locator("#x-sequence-label")).toHaveText("chr1 human chromosome one");
  await page.locator("#y-sequence").selectOption("1");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#y-sequence-label")).toHaveText("chr1 gorilla chromosome one");

  const configDownload = page.waitForEvent("download");
  await page.locator("#export-data").click();
  await page.waitForFunction(() =>
    (window as unknown as { __nativeSave?: { closedCount: number } }).__nativeSave?.closedCount === 1);
  const saved = await page.evaluate(() =>
    (window as unknown as { __nativeSave: { suggestedName: string; contents: string } }).__nativeSave);
  expect(saved.suggestedName).toBe("moddotplot-chr1_human-vs-chr1_gorilla.bedpe");
  const dataRows = saved.contents.split("\n").filter((row) => row && !row.startsWith("#"));
  expect(dataRows.length).toBeGreaterThan(0);
  expect(dataRows.every((row) => row.startsWith("chr1\t"))).toBe(true);
  expect(saved.contents).not.toContain("human chromosome one\t");
  expect(saved.contents).not.toContain("gorilla chromosome one\t");
  const configArtifact = await configDownload;
  const configPath = await configArtifact.path();
  if (!configPath) throw new Error("CLI config export has no temporary path");
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    fasta: ["./human.fa", "./gorilla.fa"],
    sequence: ["chr1", "chr1"],
    compare_only: true,
  });
});

test("multi-record inputs expose self, pairwise, and bounded grid plot modes", async ({ page }) => {
  await page.goto("/");
  await loadFasta(page, "three.fa", [
    ">alpha first record",
    "ACGTACGTACGTACGTACGTACGT",
    ">beta second record",
    "ACGTACGTACGTACGTACGTACGA",
    ">gamma third record",
    "ACGTACGTACGTACGTACGTACGG",
    "",
  ].join("\n"));

  const tabs = page.locator("#plot-mode-tabs");
  await expect(tabs).toBeVisible();
  await expect(page.locator("#plot-mode-self")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#self-selection-panel")).toBeVisible();
  await expect(page.locator("#pairwise-selection-panel")).toBeHidden();
  await expect(page.locator("#grid-selection-panel")).toBeHidden();

  await page.locator("#self-sequence").selectOption("1");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#x-sequence-label")).toHaveText("beta second record");
  await expect(page.locator("#y-sequence-label")).toHaveText("beta second record");

  await page.locator("#plot-mode-pairwise").click();
  await expect(page.locator("#pairwise-selection-panel")).toBeVisible();
  await expect(page.locator("#self-selection-panel")).toBeHidden();
  await expect(page.locator("#x-sequence")).toHaveValue("0");
  await expect(page.locator("#y-sequence")).toHaveValue("1");

  await page.locator("#x-sequence").selectOption("1");
  await expect(page.locator("#x-sequence")).toHaveValue("1");
  await expect(page.locator("#y-sequence")).toHaveValue("0");
  await page.locator("#y-sequence").selectOption("1");
  await expect(page.locator("#x-sequence")).toHaveValue("0");
  await expect(page.locator("#y-sequence")).toHaveValue("1");

  await page.locator("#plot-mode-grid").click();
  await expect(page.locator("#grid-selection-panel")).toBeVisible();
  await expect(page.locator("#plot-window-size")).toHaveText("Varies by grid plot");
  await expect(page.locator("#plot-grid-view")).toBeVisible();
  await expect(page.locator("#plot-shell")).toBeHidden();
  await expect(page.locator("#identity-histogram")).toBeHidden();
  await expect(page.locator("#grid-size")).toHaveValue("3");
  await expect(page.locator(".grid-sequence-select")).toHaveCount(3);
  await expect(page.locator(".grid-plot-cell")).toHaveCount(9);
  await expect(page.locator('.grid-plot-cell[data-canonical="true"]')).toHaveCount(6);
  await expect(page.locator(".grid-plot-cell.is-diagonal")).toHaveCount(3);
  await expect(page.locator("#feature-track-controls")).toBeHidden();
  await expect(page.locator("#plot-actions")).toBeHidden();
  await expect(page.locator("#status")).toContainText("Ready · 6 grid comparisons", { timeout: 30_000 });
  await expect(page.locator(".grid-plot-cell.is-ready")).toHaveCount(9);
  await expect(page.locator('.grid-plot-cell[data-x-index="0"][data-y-index="0"]'))
    .toHaveAttribute("data-grid-row", "2");
  await expect(page.locator('.grid-plot-cell[data-x-index="1"][data-y-index="1"]'))
    .toHaveAttribute("data-grid-row", "1");
  await expect(page.locator('.grid-plot-cell[data-x-index="2"][data-y-index="2"]'))
    .toHaveAttribute("data-grid-row", "0");
  await expect(page.locator('.plot-grid-axis-label[data-grid-axis="x"][data-sequence-index="0"]'))
    .toHaveAttribute("data-grid-position", "0");
  await expect(page.locator('.plot-grid-axis-label[data-grid-axis="y"][data-sequence-index="0"]'))
    .toHaveCSS("grid-row-start", "4");
  await expect(page.locator('.plot-grid-axis-label[data-grid-axis="y"][data-sequence-index="2"]'))
    .toHaveCSS("grid-row-start", "2");
  await expect(page.locator('.grid-plot-cell[data-grid-row="0"][data-grid-column="0"]'))
    .toHaveAttribute("aria-label", /Status: Ready$/);
  expect(await page.evaluate(() => {
    const topRowLabel = document.querySelector(
      '.plot-grid-axis-label[data-grid-axis="y"][data-sequence-index="2"]',
    );
    return topRowLabel?.nextElementSibling?.matches(
      '.grid-plot-cell[data-grid-row="0"][data-grid-column="0"]',
    ) ?? false;
  })).toBe(true);
  const gridBackingSizes = await page.locator(".grid-plot-cell canvas").evaluateAll((canvases) =>
    canvases.map((canvas) => ({
      width: (canvas as HTMLCanvasElement).width,
      height: (canvas as HTMLCanvasElement).height,
    })));
  expect(gridBackingSizes).toHaveLength(9);
  expect(gridBackingSizes.every(({ width, height }) => width === 512 && height === 512)).toBe(true);

  const openedGridCell = page.locator('.grid-plot-cell[data-grid-row="0"][data-grid-column="0"]');
  await openedGridCell.click();
  await expect(page.locator("#plot-mode-pairwise")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#plot-mode-pairwise")).toBeFocused();
  await expect(page.locator("#x-sequence")).toHaveValue("0");
  await expect(page.locator("#y-sequence")).toHaveValue("2");
  await expect(page.locator("#plot-shell")).toBeVisible();
  await expect(page.locator("#identity-histogram")).toBeVisible();
  await expect(page.locator("#back-to-grid")).toBeVisible();
  await expect(page.locator("#plot-window-size")).toHaveText("1 bp per cell");

  await page.locator("#back-to-grid").click();
  await expect(page.locator("#plot-mode-grid")).toHaveAttribute("aria-selected", "true");
  await expect(openedGridCell).toBeFocused();
  await expect(page.locator("#plot-grid-view")).toBeVisible();
  await expect(page.locator("#back-to-grid")).toBeHidden();
  await expect(page.locator("#plot-window-size")).toHaveText("Varies by grid plot");
  await expect(page.locator(".grid-plot-cell.is-ready")).toHaveCount(9);

  const transposedGridCell = page.locator('.grid-plot-cell[data-grid-row="2"][data-grid-column="2"]');
  await transposedGridCell.click();
  await expect(page.locator("#x-sequence")).toHaveValue("2");
  await expect(page.locator("#y-sequence")).toHaveValue("0");
  await page.locator("#back-to-grid").click();
  await expect(transposedGridCell).toBeFocused();
});

test("grid axes share a draggable order without recomputing plots", async ({ page }) => {
  await page.addInitScript(() => {
    const harness = window as Window & { __gridPrepareRequests?: number };
    harness.__gridPrepareRequests = 0;
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[]): void {
      if (typeof message === "object" && message !== null
        && (message as { type?: string }).type === "prepare") {
        harness.__gridPrepareRequests = (harness.__gridPrepareRequests ?? 0) + 1;
      }
      if (transfer === undefined) originalPostMessage.call(this, message);
      else originalPostMessage.call(this, message, transfer);
    } as typeof Worker.prototype.postMessage;
  });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  await loadFasta(page, "reorder.fa", [
    ">alpha",
    "ACGTACGTACGTACGTACGTACGT",
    ">beta",
    "ACGTACGTACGTACGTACGTACGA",
    ">gamma",
    "ACGTACGTACGTACGTACGTACGG",
    "",
  ].join("\n"));
  await page.locator("#plot-mode-grid").click();
  await expect(page.locator("#status")).toContainText("Ready · 6 grid comparisons", { timeout: 30_000 });

  const preparesBeforeReorder = await page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0);
  const retainedCell = page.locator('.grid-plot-cell[data-x-index="0"][data-y-index="2"] canvas');
  const retainedImage = await retainedCell.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const alphaX = page.locator('.plot-grid-axis-label[data-grid-axis="x"][data-sequence-index="0"]');
  const gammaX = page.locator('.plot-grid-axis-label[data-grid-axis="x"][data-sequence-index="2"]');
  await alphaX.dragTo(gammaX);

  await expect(alphaX).toHaveAttribute("data-grid-position", "2");
  await expect(page.locator('.plot-grid-axis-label[data-grid-axis="y"][data-sequence-index="0"]'))
    .toHaveAttribute("data-grid-position", "2");
  await expect(page.locator('.grid-plot-cell[data-x-index="0"][data-y-index="0"]'))
    .toHaveAttribute("data-grid-row", "0");
  await expect(page.locator('.grid-plot-cell[data-x-index="0"][data-y-index="0"]'))
    .toHaveAttribute("data-grid-column", "2");
  expect(await retainedCell.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(retainedImage);
  expect(await page.evaluate(() => {
    const topRowLabel = document.querySelector(
      '.plot-grid-axis-label[data-grid-axis="y"][data-sequence-index="0"]',
    );
    return topRowLabel?.nextElementSibling?.matches(
      '.grid-plot-cell[data-grid-row="0"][data-grid-column="0"]',
    ) ?? false;
  })).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0))
    .toBe(preparesBeforeReorder);

  const alphaY = page.locator('.plot-grid-axis-label[data-grid-axis="y"][data-sequence-index="0"]');
  const betaY = page.locator('.plot-grid-axis-label[data-grid-axis="y"][data-sequence-index="1"]');
  await alphaY.dragTo(betaY);
  await expect(alphaY).toHaveAttribute("data-grid-position", "0");
  await expect(alphaX).toHaveAttribute("data-grid-position", "0");
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0))
    .toBe(preparesBeforeReorder);

  await alphaY.focus();
  await alphaY.press("ArrowUp");
  await expect(alphaY).toBeFocused();
  await expect(alphaY).toHaveAttribute("data-grid-position", "1");
  await expect(alphaX).toHaveAttribute("data-grid-position", "1");
  await expect(page.locator("#grid-selection-note")).toContainText("moved to position 2");
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0))
    .toBe(preparesBeforeReorder);

  const movedReciprocal = page.locator('.grid-plot-cell[data-x-index="1"][data-y-index="0"]');
  await movedReciprocal.click();
  await expect(page.locator("#x-sequence")).toHaveValue("1");
  await expect(page.locator("#y-sequence")).toHaveValue("0");
  await page.locator("#back-to-grid").click();
  await expect(movedReciprocal).toBeFocused();
});

test("grid plots share the largest selected genomic scale through reciprocal and reordered cells", async ({ page }) => {
  await page.addInitScript(() => {
    const harness = window as Window & { __gridPrepareRequests?: number };
    harness.__gridPrepareRequests = 0;
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[]): void {
      if (typeof message === "object" && message !== null
        && (message as { type?: string }).type === "prepare") {
        harness.__gridPrepareRequests = (harness.__gridPrepareRequests ?? 0) + 1;
      }
      if (transfer === undefined) originalPostMessage.call(this, message);
      else originalPostMessage.call(this, message, transfer);
    } as typeof Worker.prototype.postMessage;
  });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");
  const periodicDna = (length: number): string => "ACGT".repeat(length / 4);
  await loadFasta(page, "shared-scale.fa", [
    `>long\n${periodicDna(32_768)}`,
    `>medium\n${periodicDna(24_576)}`,
    `>short\n${periodicDna(16_384)}`,
    "",
  ].join("\n"));
  await page.locator("#plot-mode-grid").click();
  await expect(page.locator("#status")).toContainText("Ready · 6 grid comparisons", {
    timeout: 60_000,
  });
  await expect(page.locator(".grid-plot-cell.is-ready")).toHaveCount(9);
  await expect(page.locator("#plot-grid")).toHaveAttribute("data-domain-length", "32768");

  const longSelf = page.locator(
    '.grid-plot-cell[data-x-index="0"][data-y-index="0"] canvas',
  );
  const mediumSelf = page.locator(
    '.grid-plot-cell[data-x-index="1"][data-y-index="1"] canvas',
  );
  const shortSelf = page.locator(
    '.grid-plot-cell[data-x-index="2"][data-y-index="2"] canvas',
  );
  const longByShort = page.locator(
    '.grid-plot-cell[data-x-index="0"][data-y-index="2"] canvas',
  );
  const shortByLong = page.locator(
    '.grid-plot-cell[data-x-index="2"][data-y-index="0"] canvas',
  );
  const mediumByShort = page.locator(
    '.grid-plot-cell[data-x-index="1"][data-y-index="2"] canvas',
  );
  const shortByMedium = page.locator(
    '.grid-plot-cell[data-x-index="2"][data-y-index="1"] canvas',
  );

  await expect(page.locator('.grid-plot-cell[data-x-index="0"][data-y-index="2"]'))
    .toHaveAttribute("data-x-length", "32768");
  await expect(page.locator('.grid-plot-cell[data-x-index="0"][data-y-index="2"]'))
    .toHaveAttribute("data-y-length", "16384");
  expectPaintedExtent(await canvasPaintBounds(longSelf), 1, 1);
  expectPaintedExtent(await canvasPaintBounds(mediumSelf), 0.75, 0.75);
  expectPaintedExtent(await canvasPaintBounds(shortSelf), 0.5, 0.5);
  expectPaintedExtent(await canvasPaintBounds(longByShort), 1, 0.5);
  expectPaintedExtent(await canvasPaintBounds(shortByLong), 0.5, 1);
  expectPaintedExtent(await canvasPaintBounds(mediumByShort), 0.75, 0.5);
  expectPaintedExtent(await canvasPaintBounds(shortByMedium), 0.5, 0.75);
  if (process.env.MODDOTPLOT_GRID_QA) {
    await page.locator("#plot-grid-view").screenshot({ path: process.env.MODDOTPLOT_GRID_QA });
  }

  const transposeMismatches = await page.locator([
    '.grid-plot-cell[data-x-index="0"][data-y-index="2"] canvas',
    '.grid-plot-cell[data-x-index="2"][data-y-index="0"] canvas',
  ].join(", ")).evaluateAll((canvases: HTMLCanvasElement[]) => {
    const byAxes = new Map(canvases.map((canvas) => {
      const cell = canvas.closest<HTMLElement>(".grid-plot-cell");
      return [`${cell?.dataset.xIndex}:${cell?.dataset.yIndex}`, canvas] as const;
    }));
    const normal = byAxes.get("0:2");
    const reciprocal = byAxes.get("2:0");
    if (!normal || !reciprocal) throw new Error("Reciprocal grid canvases are unavailable");
    const normalPixels = normal.getContext("2d")
      ?.getImageData(0, 0, normal.width, normal.height).data;
    const reciprocalPixels = reciprocal.getContext("2d")
      ?.getImageData(0, 0, reciprocal.width, reciprocal.height).data;
    if (!normalPixels || !reciprocalPixels) throw new Error("Grid canvas pixels are unavailable");
    let mismatches = 0;
    for (let y = 0; y < normal.height; y += 1) {
      for (let x = 0; x < normal.width; x += 1) {
        const normalOffset = (y * normal.width + x) * 4;
        const reciprocalX = normal.height - y - 1;
        const reciprocalY = normal.width - x - 1;
        const reciprocalOffset = (reciprocalY * reciprocal.width + reciprocalX) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          if (normalPixels[normalOffset + channel] !== reciprocalPixels[reciprocalOffset + channel]) {
            mismatches += 1;
            break;
          }
        }
      }
    }
    return mismatches;
  });
  expect(transposeMismatches).toBe(0);

  const preparesBeforeReorder = await page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0);
  const shortSelfImage = await shortSelf.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const reciprocalImage = await shortByLong.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.locator(
    '.plot-grid-axis-label[data-grid-axis="x"][data-sequence-index="2"]',
  ).dragTo(page.locator(
    '.plot-grid-axis-label[data-grid-axis="x"][data-sequence-index="0"]',
  ));

  await expect(page.locator('.grid-plot-cell[data-x-index="2"][data-y-index="2"]'))
    .toHaveAttribute("data-grid-column", "0");
  await expect(page.locator('.grid-plot-cell[data-x-index="2"][data-y-index="2"]'))
    .toHaveAttribute("data-grid-row", "2");
  await expect(page.locator("#plot-grid")).toHaveAttribute("data-domain-length", "32768");
  expect(await shortSelf.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()))
    .toBe(shortSelfImage);
  expect(await shortByLong.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()))
    .toBe(reciprocalImage);
  expectPaintedExtent(await canvasPaintBounds(shortSelf), 0.5, 0.5);
  expectPaintedExtent(await canvasPaintBounds(shortByLong), 0.5, 1);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0))
    .toBe(preparesBeforeReorder);
});

test("realistic grid sketches preserve focus and avoid no-op recomputation", async ({ page }) => {
  await page.addInitScript(() => {
    const harness = window as Window & { __gridPrepareRequests?: number };
    harness.__gridPrepareRequests = 0;
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[]): void {
      if (typeof message === "object" && message !== null
        && (message as { type?: string }).type === "prepare") {
        harness.__gridPrepareRequests = (harness.__gridPrepareRequests ?? 0) + 1;
      }
      if (transfer === undefined) originalPostMessage.call(this, message);
      else originalPostMessage.call(this, message, transfer);
    } as typeof Worker.prototype.postMessage;
  });
  await page.goto("/");
  const records = Array.from({ length: 4 }, (_, index) =>
    `>sketch${index + 1}\n${deterministicDna(20_000, 31 + index * 7)}`);
  await loadFasta(page, "sketch-grid.fa", `${records.join("\n")}\n`);
  await page.locator("#plot-mode-grid").click();
  await expect(page.locator("#status")).toContainText("Ready · 6 grid comparisons", { timeout: 30_000 });
  await expect(page.locator(".grid-plot-cell.is-ready")).toHaveCount(9);

  const preparesAfterInitialGrid = await page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0);
  const retainedGridImage = await page
    .locator('.grid-plot-cell[data-grid-row="0"][data-grid-column="1"] canvas')
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

  await page.locator('.grid-plot-cell[data-grid-row="0"][data-grid-column="1"]').click();
  await expect(page.locator("#back-to-grid")).toBeVisible();
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });
  const preparesAfterDetail = await page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0);
  expect(preparesAfterDetail).toBeGreaterThan(preparesAfterInitialGrid);
  await page.locator('[data-background-mode="black"]').click();
  expect(await page
    .locator('.grid-plot-cell[data-grid-row="0"][data-grid-column="1"] canvas')
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(retainedGridImage);
  await page.locator("#back-to-grid").click();
  await expect(page.locator("#plot-grid-view")).toBeVisible();
  await expect(page.locator(".grid-plot-cell.is-ready")).toHaveCount(9);
  await expect(page
    .locator('.grid-plot-cell[data-grid-row="0"][data-grid-column="1"] canvas'))
    .toHaveJSProperty("width", 512);
  expect(await page
    .locator('.grid-plot-cell[data-grid-row="0"][data-grid-column="1"] canvas')
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(retainedGridImage);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0))
    .toBe(preparesAfterDetail);

  await page.locator("#plot-mode-grid").click();
  await page.locator("#resolution").selectOption("500", { force: true });
  await page.locator("#detailed-register-count").selectOption("512", { force: true });
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0))
    .toBe(preparesAfterDetail);

  const thirdSelector = page.locator('.grid-sequence-select[data-grid-position="2"]');
  await thirdSelector.selectOption("3");
  await expect(page.locator('.grid-sequence-select[data-grid-position="2"]')).toBeFocused();
  await expect(page.locator("#status")).toContainText("Ready · 6 grid comparisons", { timeout: 30_000 });
  await expect(page.locator(".grid-plot-cell.is-ready")).toHaveCount(9);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __gridPrepareRequests?: number }).__gridPrepareRequests ?? 0))
    .toBeGreaterThan(preparesAfterDetail);
});

test("a failed grid comparison leaves completed cells available", async ({ page }) => {
  await page.addInitScript(() => {
    let prepareCount = 0;
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[]): void {
      if (typeof message === "object" && message !== null
        && (message as { type?: string }).type === "prepare") {
        prepareCount += 1;
        if (prepareCount === 3) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
            data: { type: "error", message: "Injected grid comparison failure" },
          })));
          return;
        }
      }
      if (transfer === undefined) originalPostMessage.call(this, message);
      else originalPostMessage.call(this, message, transfer);
    } as typeof Worker.prototype.postMessage;
  });
  await page.goto("/");
  await loadFasta(page, "grid-error.fa", [
    `>first\n${deterministicDna(3_000, 3)}`,
    `>second\n${deterministicDna(3_000, 7)}`,
    `>third\n${deterministicDna(3_000, 11)}`,
  ].join("\n"));
  await page.locator("#plot-mode-grid").click();
  await expect(page.locator("#status")).toContainText("Injected grid comparison failure", {
    timeout: 30_000,
  });
  const readyCell = page.locator(".grid-plot-cell.is-ready:not(:disabled)").first();
  await expect(readyCell).toBeEnabled();
  await readyCell.click();
  await expect(page.locator("#back-to-grid")).toBeVisible();
  await page.locator("#back-to-grid").click();
  await expect(page.locator("#plot-grid-view")).toBeVisible();
  await expect(page.locator("#status")).not.toHaveClass(/error/);
  await expect(page.locator("#status")).toContainText("Ready ·");
});

test("single-record input keeps mode tabs hidden and presents one self selector", async ({ page }) => {
  await page.goto("/");
  await loadFasta(page, "one.fa", shortFasta);
  await expect(page.locator("#plot-mode-tabs")).toBeHidden();
  await expect(page.locator("#self-selection-panel")).toBeVisible();
  await expect(page.locator("#pairwise-selection-panel")).toBeHidden();
  await expect(page.locator("#self-sequence option")).toHaveText("chrShort_one · 32 bp");
});

test("grid selection is capped at six distinct sequences", async ({ page }) => {
  await page.goto("/");
  const records = Array.from({ length: 7 }, (_, index) =>
    `>sequence${index + 1}\n${"ACGT".repeat(6)}${"ACGTACG"[index]}`);
  await loadFasta(page, "seven.fa", `${records.join("\n")}\n`);
  await page.locator("#plot-mode-grid").click();
  await expect(page.locator("#grid-size option")).toHaveText([
    "2 sequences",
    "3 sequences",
    "4 sequences",
    "5 sequences",
    "6 sequences",
  ]);
  await page.locator("#grid-size").selectOption("6");
  await expect(page.locator(".grid-sequence-select")).toHaveCount(6);
  await expect(page.locator(".grid-plot-cell")).toHaveCount(36);
  await expect(page.locator('.grid-plot-cell[data-canonical="true"]')).toHaveCount(21);
  const selected = await page.locator(".grid-sequence-select").evaluateAll((controls) =>
    controls.map((control) => (control as HTMLSelectElement).value));
  expect(new Set(selected).size).toBe(6);
});

test("a newer landing validation wins over compressed input and clear rejects stale publication", async ({ page }) => {
  await page.goto("/");
  // Keep the first validation in flight long enough for every browser engine to
  // observe and supersede it deterministically rather than racing a 1 MB parse.
  const large = `>stale\n${"ACGT".repeat(3_000_000)}\n`;
  await page.locator("#file-input").setInputFiles({
    name: "stale.fa.gz",
    mimeType: "application/gzip",
    buffer: gzipSync(Buffer.from(large)),
  });
  await expect(page.locator("#fasta-selection")).toContainText("Reading and validating");
  await expect(page.locator("#landing")).toBeVisible();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator("#plot-loading")).toBeHidden();
  await loadFasta(page, "current.fa", ">current\nACGTACGTACGTACGTACGTACGT\n");

  await expect(page.locator("#x-sequence option")).toHaveText("current_current · 24 bp", {
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

test("responsive controls keep Clear separate and report the current plot window size", async ({ page }) => {
  await page.setViewportSize({ width: 1_000, height: 900 });
  await page.goto("/");
  await page.locator("#resolution").selectOption("500", { force: true });
  await loadFasta(page, "window-size.fa", `>windowSize\n${deterministicDna(24_000)}\n`);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 30_000 });

  for (const viewport of [
    { width: 1_550, height: 1_000 },
    { width: 1_200, height: 800 },
    { width: 761, height: 900 },
    { width: 760, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".control-header")!.getBoundingClientRect();
      const title = document.querySelector(".control-header h1")!.getBoundingClientRect();
      const clear = document.querySelector("#clear-button")!.getBoundingClientRect();
      const controls = document.querySelector(".controls")!.getBoundingClientRect();
      const plot = document.querySelector("#plot-column")!.getBoundingClientRect();
      return {
        headerLeft: header.left,
        headerRight: header.right,
        titleRight: title.right,
        clearLeft: clear.left,
        clearRight: clear.right,
        controlsBottom: controls.bottom,
        plotLeft: plot.left,
        plotTop: plot.top,
      };
    });
    expect(layout.clearLeft).toBeGreaterThanOrEqual(layout.headerLeft - 0.5);
    expect(layout.clearRight).toBeLessThanOrEqual(layout.headerRight + 0.5);
    expect(layout.titleRight).toBeLessThanOrEqual(layout.clearLeft - 9.5);
    if (viewport.width > 760) {
      expect(layout.clearRight).toBeLessThanOrEqual(layout.plotLeft);
    } else {
      expect(layout.controlsBottom).toBeLessThanOrEqual(layout.plotTop + 0.5);
    }
  }

  await page.setViewportSize({ width: 1_000, height: 900 });
  await page.locator(".advanced-controls summary").click();
  await expect(page.locator(".advanced-controls label:has(#resolution) > span"))
    .toHaveText("Plot resolution");
  await expect(page.locator("#plot-window-size")).toHaveText("48 bp per cell");
  const canvas = page.locator("#plot-canvas");
  await canvas.focus();
  await page.keyboard.press("+");
  await expect(page.locator("#plot-window-size")).toHaveText("24 bp per cell");
  await expect(page.locator("#plot-window-size-note")).toContainText("1,000 cells per axis");
  await page.keyboard.press("Home");
  await expect(page.locator("#plot-window-size")).toHaveText("48 bp per cell");
  if (process.env.MODDOTPLOT_V082_QA) {
    await page.screenshot({ path: process.env.MODDOTPLOT_V082_QA, fullPage: true });
  }
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
          && message.type === "prepare"
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
  await expect(page.locator("#x-sequence option")).toHaveText("chrShort_recover · 32 bp", {
    timeout: 15_000,
  });
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#retry-engine")).toBeHidden();
});

test("exact mode keeps fixed full footprints while the initial comparison is preparing", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const nativePostMessage = NativeWorker.prototype.postMessage;
    const heldPrepares: Array<() => void> = [];
    let holdFirstPrepare = true;
    Object.defineProperty(window, "__releaseExactPrepare", {
      value: () => heldPrepares.shift()?.(),
    });
    window.Worker = class DelayedPrepareWorker extends NativeWorker {
      postMessage(message: unknown, transfer?: Transferable[]): void {
        if (
          holdFirstPrepare
          && typeof message === "object"
          && message !== null
          && "type" in message
          && message.type === "prepare"
        ) {
          holdFirstPrepare = false;
          heldPrepares.push(() => nativePostMessage.call(this, message, transfer ?? []));
          return;
        }
        nativePostMessage.call(this, message, transfer ?? []);
      }
    } as typeof Worker;
  });

  await page.goto("/");
  await loadFasta(page, "delayed-exact.fa", shortFasta);
  await expect(page.locator("#exact-mode-controls")).toBeVisible();
  await expect(page.locator("[data-exact-geometry]")).toHaveCount(0);
  await expect(page.locator("#show-direction")).toHaveCount(0);
  await expect(page.locator('[data-exact-view="bases"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#exact-mode-banner")).toContainText("full footprints");
  await expect(page.locator("#scientific-provenance")).toContainText("Full footprints");

  await page.evaluate(() => {
    (window as Window & { __releaseExactPrepare: () => void }).__releaseExactPrepare();
  });
  await expect(page.locator("#status")).toContainText("cached", { timeout: 15_000 });
  await expect(page.locator("#scientific-provenance")).toContainText("Full footprints");
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

  await page.locator("#plot-mode-pairwise").click();
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

  await page.locator("#file-input").setInputFiles({
    name: "invalid.fa",
    mimeType: "text/plain",
    buffer: Buffer.from("chr1\t0\t10\n"),
  });
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
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", {
    timeout: 20_000,
  });
  await exploreStagedFasta(page);

  await expect(page.locator("#x-sequence option")).toHaveText("ambiguous_ambiguous · 33 bp");
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
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", {
    timeout: 20_000,
  });
  await exploreStagedFasta(page);

  await expect(page.locator("#x-sequence option")).toHaveText([
    "chrA_two-records · 12 bp",
    "chrB_two-records · 8 bp",
  ]);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(page.locator("#sequence-load-dialog")).toBeHidden();
});

test("FAI companions expose metadata first and load selected plain records on demand", async ({ page }) => {
  await page.goto("/");
  const first = deterministicDna(2_048, 31);
  const second = deterministicDna(1_536, 47);
  const firstHeader = ">chrIndexedOne indexed description\n";
  const secondHeader = ">chrIndexedTwo another description\n";
  const firstRecord = `${firstHeader}${first}\n`;
  const fasta = `${firstRecord}${secondHeader}${second}\n`;
  const fai = [
    `chrIndexedOne\t${first.length}\t${Buffer.byteLength(firstHeader)}\t${first.length}\t${first.length + 1}`,
    `chrIndexedTwo\t${second.length}\t${Buffer.byteLength(firstRecord) + Buffer.byteLength(secondHeader)}\t${second.length}\t${second.length + 1}`,
    "",
  ].join("\n");

  await page.locator("#file-input").setInputFiles([
    { name: "indexed.fa", mimeType: "text/plain", buffer: Buffer.from(fasta) },
    { name: "indexed.fa.fai", mimeType: "text/plain", buffer: Buffer.from(fai) },
  ]);
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", { timeout: 20_000 });
  await expect(page.locator("#self-sequence option")).toHaveText([
    "chrIndexedOne_indexed · 2.05 kb",
    "chrIndexedTwo_indexed · 1.54 kb",
  ]);
  await exploreStagedFasta(page);

  await expect(page.locator("#status")).toContainText("Ready", { timeout: 20_000 });
  await expect(page.locator("#x-sequence-label")).toHaveText("chrIndexedOne");
  await page.locator("#self-sequence").selectOption("1");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 20_000 });
  await expect(page.locator("#x-sequence-label")).toHaveText("chrIndexedTwo");
  await expect(page.locator("#sequence-load-dialog")).toBeHidden();
});

test("FAI and GZI companions lazily load BGZF records", async ({ page }) => {
  await page.goto("/");
  const first = deterministicDna(1_024, 71);
  const second = deterministicDna(768, 89);
  const firstHeader = ">bgzfOne\n";
  const secondHeader = ">bgzfTwo\n";
  const firstRecord = `${firstHeader}${first}\n`;
  const secondRecord = `${secondHeader}${second}\n`;
  const firstBlock = bgzfBlock(firstRecord);
  const secondBlock = bgzfBlock(secondRecord);
  const bgzf = Buffer.concat([firstBlock, secondBlock]);
  const fai = [
    `bgzfOne\t${first.length}\t${Buffer.byteLength(firstHeader)}\t${first.length}\t${first.length + 1}`,
    `bgzfTwo\t${second.length}\t${Buffer.byteLength(firstRecord) + Buffer.byteLength(secondHeader)}\t${second.length}\t${second.length + 1}`,
    "",
  ].join("\n");
  const gzi = gziBuffer([{
    compressed: firstBlock.byteLength,
    uncompressed: Buffer.byteLength(firstRecord),
  }]);

  await page.locator("#file-input").setInputFiles([
    { name: "indexed.fa.gz", mimeType: "application/gzip", buffer: bgzf },
    { name: "indexed.fa.gz.fai", mimeType: "text/plain", buffer: Buffer.from(fai) },
    { name: "indexed.fa.gz.gzi", mimeType: "application/octet-stream", buffer: gzi },
  ]);
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", { timeout: 20_000 });
  await expect(page.locator("#self-sequence option")).toHaveCount(2);
  await exploreStagedFasta(page);

  await expect(page.locator("#status")).toContainText("Ready", { timeout: 20_000 });
  await page.locator("#self-sequence").selectOption("1");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 20_000 });
  await expect(page.locator("#x-sequence-label")).toHaveText("bgzfTwo");
  await expect(page.locator("#sequence-load-dialog")).toBeHidden();
});

test("ordinary gzip with index-shaped companions safely keeps eager ingestion", async ({ page }) => {
  await page.goto("/");
  const sequence = deterministicDna(1_024, 101);
  const header = ">gzipFallback retained description\n";
  const fasta = `${header}${sequence}\n`;
  const fai = `gzipFallback\t${sequence.length}\t${Buffer.byteLength(header)}\t${sequence.length}\t${sequence.length + 1}\n`;

  await page.locator("#file-input").setInputFiles([
    { name: "fallback.fa.gz", mimeType: "application/gzip", buffer: gzipSync(Buffer.from(fasta)) },
    { name: "fallback.fa.gz.fai", mimeType: "text/plain", buffer: Buffer.from(fai) },
    { name: "fallback.fa.gz.gzi", mimeType: "application/octet-stream", buffer: gziBuffer([]) },
  ]);
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", { timeout: 20_000 });
  await exploreStagedFasta(page);

  await expect(page.locator("#status")).toContainText("Ready", { timeout: 20_000 });
  await expect(page.locator("#x-sequence-label")).toHaveText(
    "gzipFallback retained description",
  );
  await expect(page.locator("#sequence-load-dialog")).toBeHidden();
});

test("orphan FASTA indexes fail before a dataset is committed", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles({
    name: "missing.fa.fai",
    mimeType: "text/plain",
    buffer: Buffer.from("missing\t4\t9\t4\t5\n"),
  });
  await expect(page.locator("#sequence-load-dialog")).toBeVisible();
  await expect(page.locator("#sequence-load-details")).toContainText(
    "has no matching FASTA file named 'missing.fa'",
  );
  await expect(page.locator("#explore-button")).toBeHidden();
  await expect(page.locator("#workspace")).toBeHidden();
});

test("a stale FAI cannot bind one indexed name to another FASTA record", async ({ page }) => {
  await page.goto("/");
  const first = ">actualA\nACGTACGTACGTACGTACGTACGT\n";
  const secondHeader = ">actualB\n";
  const second = "TTTTCCCCAAAAGGGGTTTTCCCC";
  const fasta = `${first}${secondHeader}${second}\n`;
  const staleFai = `claimedA\t${second.length}\t${Buffer.byteLength(first) + Buffer.byteLength(secondHeader)}\t${second.length}\t${second.length + 1}\n`;
  await page.locator("#file-input").setInputFiles([
    { name: "stale.fa", mimeType: "text/plain", buffer: Buffer.from(fasta) },
    { name: "stale.fa.fai", mimeType: "text/plain", buffer: Buffer.from(staleFai) },
  ]);
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", { timeout: 20_000 });
  await exploreStagedFasta(page);

  await expect(page.locator("#status")).toContainText(
    "FAI record 'claimedA' points to FASTA header 'actualB'",
    { timeout: 20_000 },
  );
  await expect(page.locator("#status")).toHaveClass(/error/);
  await expect(page.locator("#plot-canvas")).toBeVisible();
  await expect(page.locator("#plot-loading")).toBeHidden();
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

test("BED and GFF logical tracks span matching sequences and disable by dragging away", async ({ page }) => {
  await page.goto("/");
  await page.locator("#resolution").selectOption("500", { force: true });
  await loadFasta(page, "annotations.fa", `>chr1\n${"ACGT".repeat(300)}\n>chr2\n${"TGCA".repeat(300)}\n`);
  await page.locator("#plot-mode-pairwise").click();
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
  const bedRow = page.locator(".imported-track-control", { hasText: "colored" });
  await expect(bedRow).toHaveCount(1, { timeout: 15_000 });
  await expect(bedRow).toContainText("2 matching sequences · BED · 3 displayed features");
  const bedX = bedRow.locator('input[id$="-x"]');
  const bedY = bedRow.locator('input[id$="-y"]');
  const bedBoth = bedRow.locator('input[id$="-both"]');
  await expect(bedX).toBeChecked();
  await expect(bedY).toBeChecked();
  await expect(bedBoth).toBeChecked();
  await expect(bedX).toBeEnabled();
  await expect(bedY).toBeEnabled();
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
  const bedYPanel = page.locator('#y-feature-track-stack .imported-feature-track-panel:not([hidden])', { hasText: "colored" });
  await expect(bedPanel).toBeVisible();
  await expect(bedYPanel).toBeVisible();
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
  await expect.poll(() => bedYPanel.locator("canvas").evaluate((track: HTMLCanvasElement) => {
    const pixels = track.getContext("2d")?.getImageData(0, 0, track.width, track.height).data;
    return pixels?.some((red, index) => index % 4 === 0
      && red > 180
      && (pixels[index + 1] ?? 255) < 80
      && (pixels[index + 2] ?? 255) < 80
      && pixels[index + 3] === 255) ?? false;
  })).toBe(false);

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
  await bedPanel.scrollIntoViewIfNeeded();
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

  await page.locator("#plot-mode-self").click();
  await page.locator("#self-sequence").selectOption("0");
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  await expect(bedY).toBeEnabled();
  await expect(page.locator('#y-feature-track-stack .imported-feature-track-panel:not([hidden])', { hasText: "colored" })).toBeVisible();
  await expect.poll(() => bedYPanel.locator("canvas").evaluate((track: HTMLCanvasElement) => {
    const pixels = track.getContext("2d")?.getImageData(0, 0, track.width, track.height).data;
    return pixels?.some((red, index) => index % 4 === 0
      && red > 180
      && (pixels[index + 1] ?? 255) < 80
      && (pixels[index + 2] ?? 255) < 80
      && pixels[index + 3] === 255) ?? false;
  })).toBe(true);

  await bedPanel.scrollIntoViewIfNeeded();
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
  await expect(bedBoth).toHaveJSProperty("indeterminate", true);

  await bedRow.getByRole("button", { name: "Delete colored data" }).click();
  await expect(bedRow).toHaveCount(0);
  await expect(page.locator(".imported-feature-track-panel", { hasText: "colored" })).toHaveCount(0);
});

test("heatmap palette and plot background controls update without recomputation", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __palettePrepareMessages?: number }).__palettePrepareMessages = 0;
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[]): void {
      if (typeof message === "object" && message !== null
        && (message as { type?: string }).type === "prepare") {
        const harness = window as unknown as { __palettePrepareMessages?: number };
        harness.__palettePrepareMessages = (harness.__palettePrepareMessages ?? 0) + 1;
      }
      if (transfer === undefined) originalPostMessage.call(this, message);
      else originalPostMessage.call(this, message, transfer);
    } as typeof Worker.prototype.postMessage;
  });
  await page.goto("/");
  await loadFasta(page, "short.fa", shortFasta);
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 15_000 });
  const prepareMessagesBeforeAppearanceChanges = await page.evaluate(() =>
    (window as unknown as { __palettePrepareMessages?: number }).__palettePrepareMessages ?? 0);
  const paletteGroups = await page.locator("#heatmap-palette optgroup").evaluateAll((groups) =>
    groups.map((group) => ({
      label: (group as HTMLOptGroupElement).label,
      options: group.querySelectorAll("option").length,
    })));
  expect(paletteGroups).toEqual([
    { label: "Spectral", options: 1 },
    { label: "Viridis", options: 1 },
    { label: "Sequential", options: 18 },
    { label: "Diverging", options: 8 },
    { label: "Qualitative", options: 8 },
  ]);
  await expect(page.locator("#heatmap-palette option")).toHaveCount(36);
  await expect(page.locator("#heatmap-palette option").nth(0)).toHaveAttribute("value", "Spectral");
  await expect(page.locator("#heatmap-palette option").nth(1)).toHaveAttribute("value", "Viridis");
  await expect(page.locator("#heatmap-palette")).toHaveValue("Spectral");
  await expect(page.locator("#heatmap-color-count")).toHaveValue("11");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("min", "3");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("max", "11");
  await expect(page.locator("#palette-flip")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".palette-swatch")).toHaveCount(11);
  await expect(page.locator(".palette-swatch").first()).toHaveCSS("background-color", "rgb(94, 79, 162)");
  await expect(page.locator(".palette-swatch").last()).toHaveCSS("background-color", "rgb(158, 1, 66)");
  const paletteOptionLayout = await page.locator(".palette-options-row").evaluate((row) => {
    const count = row.querySelector("label")!.getBoundingClientRect();
    const flip = row.querySelector(".palette-direction-control")!.getBoundingClientRect();
    return {
      widthDifference: Math.abs(count.width - flip.width),
      topDifference: Math.abs(count.top - flip.top),
    };
  });
  expect(paletteOptionLayout.widthDifference).toBeLessThanOrEqual(1);
  expect(paletteOptionLayout.topDifference).toBeLessThanOrEqual(1);
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
  expect(initialGradient).toContain("rgb(255, 255, 255)");
  expect(initialGradient.indexOf("rgb(94, 79, 162)")).toBeLessThan(
    initialGradient.indexOf("rgb(158, 1, 66)"),
  );
  await page.locator("#palette-flip").click();
  await expect(page.locator("#palette-flip")).toHaveAttribute("aria-pressed", "false");
  const canonicalGradient = await gradient.evaluate((element) => element.style.backgroundImage);
  expect(canonicalGradient).not.toBe(initialGradient);
  expect(canonicalGradient.indexOf("rgb(158, 1, 66)")).toBeLessThan(
    canonicalGradient.indexOf("rgb(94, 79, 162)"),
  );
  await page.locator("#palette-flip").click();
  await expect(page.locator("#palette-flip")).toHaveAttribute("aria-pressed", "true");

  const firstPaletteSwatch = page.locator(".palette-swatch").first();
  await firstPaletteSwatch.click();
  await expect(page.locator("#palette-color-editor")).toBeVisible();
  await expect(page.locator("#palette-color-wheel")).toHaveValue("#5e4fa2");
  await expect(page.locator("#palette-color-hex")).toBeFocused();
  await page.locator("#palette-color-hex").fill("#123456");
  await expect(page.locator("#palette-color-hex")).toHaveAttribute("aria-invalid", "false");
  await expect(page.locator(".palette-swatch").first()).toHaveCSS("background-color", "rgb(18, 52, 86)");
  await expect.poll(() => gradient.evaluate((element) => element.style.backgroundImage))
    .toContain("rgb(18, 52, 86)");
  if (process.env.MODDOTPLOT_PALETTE_QA) {
    await page.screenshot({ path: process.env.MODDOTPLOT_PALETTE_QA, fullPage: true });
  }
  await page.locator("#palette-color-reset").click();
  await expect(page.locator(".palette-swatch").first()).toHaveCSS("background-color", "rgb(94, 79, 162)");
  await page.locator("#palette-color-done").click();
  await expect(page.locator("#palette-color-editor")).toBeHidden();
  await expect(firstPaletteSwatch).toBeFocused();
  await firstPaletteSwatch.press("Enter");
  await expect(page.locator("#palette-color-hex")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#palette-color-editor")).toBeHidden();
  await expect(firstPaletteSwatch).toBeFocused();

  await page.locator("#heatmap-palette").selectOption("Viridis");
  await expect(page.locator("#palette-flip")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#heatmap-color-count")).toHaveValue("11");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("max", "12");
  await expect(page.locator(".palette-swatch").first()).toHaveCSS("background-color", "rgb(68, 1, 84)");
  await page.locator("#heatmap-palette").selectOption("Blues");
  const bluesGradient = await gradient.evaluate((element) => element.style.backgroundImage);
  expect(bluesGradient).not.toBe(initialGradient);
  await expect(page.locator("#heatmap-color-count")).toHaveValue("9");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("min", "3");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("max", "9");
  await page.locator("#heatmap-palette").selectOption("Paired");
  await expect(page.locator("#heatmap-color-count")).toHaveValue("9");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("min", "3");
  await expect(page.locator("#heatmap-color-count")).toHaveAttribute("max", "12");
  await page.locator("#heatmap-color-count").fill("12");
  await page.locator("#heatmap-color-count").dispatchEvent("change");
  await expect(page.locator("#heatmap-color-count")).toHaveValue("12");
  const twelveColorGradient = await gradient.evaluate((element) => element.style.backgroundImage);
  expect(twelveColorGradient).not.toBe(bluesGradient);

  await expect(page.locator("#heatmap-min")).toHaveAttribute("step", "0.1");
  await page.locator("#heatmap-min").evaluate((input: HTMLInputElement) => {
    input.value = "85.1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#heatmap-min-value")).toHaveText("85.1%");

  await expect(page.locator('[data-background-mode="white"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#plot-frame")).not.toHaveClass(/dark-background/);
  await page.locator('[data-background-mode="black"]').click();
  await expect(page.locator("#plot-frame")).toHaveClass(/dark-background/);
  await expect.poll(() => gradient.evaluate((element) => element.style.backgroundImage))
    .toContain("rgb(5, 5, 6)");
  await page.locator('[data-background-mode="white"]').click();
  await expect(page.locator("#plot-frame")).not.toHaveClass(/dark-background/);
  await expect.poll(() => gradient.evaluate((element) => element.style.backgroundImage))
    .toContain("rgb(255, 255, 255)");
  expect(await page.evaluate(() =>
    (window as unknown as { __palettePrepareMessages?: number }).__palettePrepareMessages ?? 0))
    .toBe(prepareMessagesBeforeAppearanceChanges);
  await expect(page.locator("#status")).toContainText("Ready");
});
