import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const PERIODIC_FASTA = `>hello
${"ACGT".repeat(18)}
`;
const MATRIX_SIZE = 72;
const EXACT_FOOTPRINT_DIGEST = "e2577c370efa7023a0e62bfe69c8ea9f5dc7d2cc91855bf7cf8e03562f291484";

type Rgb = readonly [number, number, number];

const IDENTITY_COLORS = new Map<string, number>([
  ["255,255,255", 0], // Explicit mismatch / below threshold.
  ["158,1,66", 2], // Reversed Spectral maximum, 100% identity.
]);

const BASE_COLORS = new Set([
  "255,255,255", // Explicit mismatch / below threshold.
  "51,173,61", // A
  "31,115,224", // C
  "245,163,31", // G
  "224,51,48", // T
]);

interface ExactTileSnapshot {
  configDigest: string;
  width: number;
  height: number;
  categories: number[];
  matched: number;
  mismatched: number;
  missing: number;
  other: number;
}

interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

test("periodic exact mode remains categorical across DPR, resize, and exact view", async ({
  browser,
  baseURL,
}) => {
  test.slow();
  const footprintDigests = new Set<string>();

  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({
      deviceScaleFactor,
      viewport: { width: 1280, height: 900 },
    });
    await installExactTileProbe(context);
    const page = await context.newPage();
    await page.goto(baseURL ?? "/");
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(deviceScaleFactor);
    await loadPeriodicFasta(page);

    await expect(page.locator("#heatmap-palette")).toHaveValue("Spectral");
    await expect(page.locator("#palette-flip")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-exact-view="bases"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("[data-exact-geometry]")).toHaveCount(0);
    await expect(page.locator("#show-direction")).toHaveCount(0);

    const footprint = await exactTile(page, "exact-k21-footprints");
    expectTile(footprint, { matched: 2_352, mismatched: 1_352, missing: 1_480 });
    const footprintDigest = categoricalDigest(footprint.categories);
    footprintDigests.add(footprintDigest);
    expect(footprintDigest).toBe(EXACT_FOOTPRINT_DIGEST);
    const renderedFootprintDigest = categoricalDigest(
      footprint.categories.map((category) => category === 1 ? 0 : category),
    );

    const bases = decodePng(await unobscuredCanvasScreenshot(page));
    expectOnlyColors(bases, BASE_COLORS);

    await page.locator('[data-exact-view="identity"]').click();
    await expect(page.locator('[data-exact-view="identity"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitForTwoFrames(page);

    await setPlotCssSize(page, 720);
    const identityAtIntegerScale = await captureCategoricalCanvas(page, IDENTITY_COLORS);
    expect(identityAtIntegerScale.width).toBe(720 * deviceScaleFactor);
    expect(identityAtIntegerScale.height).toBe(720 * deviceScaleFactor);
    expect(identityAtIntegerScale.digest).toBe(renderedFootprintDigest);

    // 701 is deliberately not divisible by 72. It exercises fractional CSS-to-cell
    // allocation at both one and two device pixels per CSS pixel.
    await setPlotCssSize(page, 701);
    const identityAfterResize = await captureCategoricalCanvas(page, IDENTITY_COLORS);
    expect(identityAfterResize.width).toBe(701 * deviceScaleFactor);
    expect(identityAfterResize.height).toBe(701 * deviceScaleFactor);
    expect(identityAfterResize.digest).toBe(renderedFootprintDigest);

    await page.locator('[data-exact-view="bases"]').click();
    await expect(page.locator('[data-exact-view="bases"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitForTwoFrames(page);
    const basesAfterResize = decodePng(await unobscuredCanvasScreenshot(page));
    expectOnlyColors(basesAfterResize, BASE_COLORS);

    await context.close();
  }

  expect([...footprintDigests]).toEqual([EXACT_FOOTPRINT_DIGEST]);
});

async function installExactTileProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // WebKit on a display-less Linux runner may discard a WebGL back buffer before
    // Playwright's element screenshot reads it, producing a fully opaque black PNG
    // even though the composited plot is correct. Preserve only this test canvas so
    // the pixel oracle measures the shader output rather than that readback artifact.
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      writable: true,
      value(this: HTMLCanvasElement, contextId: string, options?: unknown) {
        const contextOptions = this.id === "plot-canvas" && contextId === "webgl2"
          ? { ...(options as object | undefined), preserveDrawingBuffer: true }
          : options;
        return Reflect.apply(nativeGetContext, this, [contextId, contextOptions]);
      },
    });

    // Chromium's headless DPR emulation reports CSS-pixel values through
    // devicePixelContentBoxSize even though window.devicePixelRatio is changed. Hide that
    // optional field so every engine takes the application's standards-compatible DPR
    // fallback and the emulated DPR exercises a genuinely high-resolution backing store.
    const NativeResizeObserver = window.ResizeObserver;
    class DprFallbackResizeObserver extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => callback(entries.map((entry) => new Proxy(entry, {
          get(target, property) {
            if (property === "devicePixelContentBoxSize") return undefined;
            return Reflect.get(target, property, target);
          },
        })), observer));
      }
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: DprFallbackResizeObserver,
    });

    const NativeWorker = window.Worker;
    const snapshots: ExactTileSnapshot[] = [];
    Object.defineProperty(window, "__exactTileSnapshots", { value: snapshots });

    class ProbedWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as {
            type?: string;
            quality?: string;
            configDigest?: string;
            resolution?: number;
            x?: number;
            y?: number;
            width?: number;
            height?: number;
            identity?: Uint16Array;
          };
          if (
            data.type !== "tile"
            || data.quality !== "exact"
            || data.resolution !== 72
            || data.x !== 0
            || data.y !== 0
            || !(data.identity instanceof Uint16Array)
          ) return;

          const categories = new Array<number>(data.identity.length);
          let matched = 0;
          let mismatched = 0;
          let missing = 0;
          let other = 0;
          for (let index = 0; index < data.identity.length; index += 1) {
            const value = data.identity[index];
            if (value === 10_000) {
              matched += 1;
              categories[index] = 2;
            } else if (value === 0) {
              mismatched += 1;
              categories[index] = 0;
            } else if (value === 65_535) {
              missing += 1;
              categories[index] = 1;
            } else {
              other += 1;
              categories[index] = 3;
            }
          }
          snapshots.push({
            configDigest: data.configDigest ?? "",
            width: data.width ?? 0,
            height: data.height ?? 0,
            categories,
            matched,
            mismatched,
            missing,
            other,
          });
        });
      }
    }

    Object.defineProperty(window, "Worker", {
      configurable: true,
      writable: true,
      value: ProbedWorker,
    });
  });
}

async function loadPeriodicFasta(page: Page): Promise<void> {
  await page.locator("#file-input").setInputFiles({
    name: "periodic.fa",
    mimeType: "text/plain",
    buffer: Buffer.from(PERIODIC_FASTA),
  });
  await expect(page.locator("#fasta-selection")).toContainText("ready to explore", {
    timeout: 20_000,
  });
  await page.locator("#explore-button").click();
  await expect(page.locator("#status")).toContainText("Ready", { timeout: 20_000 });
  await expect(page.locator("#scientific-provenance")).toContainText(
    "Exact canonical 21-mer mode",
  );
}

async function exactTile(page: Page, configDigest: string): Promise<ExactTileSnapshot> {
  await page.waitForFunction((digest) => {
    const records = (window as unknown as { __exactTileSnapshots?: ExactTileSnapshot[] })
      .__exactTileSnapshots ?? [];
    return records.some((record) => record.configDigest === digest);
  }, configDigest, { timeout: 20_000 });
  return page.evaluate((digest) => {
    const records = (window as unknown as { __exactTileSnapshots?: ExactTileSnapshot[] })
      .__exactTileSnapshots ?? [];
    const record = records.findLast((candidate) => candidate.configDigest === digest);
    if (!record) throw new Error(`Missing exact tile ${digest}`);
    return record;
  }, configDigest);
}

function expectTile(
  tile: ExactTileSnapshot,
  counts: Pick<ExactTileSnapshot, "matched" | "mismatched" | "missing">,
): void {
  expect(tile.width).toBe(MATRIX_SIZE);
  expect(tile.height).toBe(MATRIX_SIZE);
  expect(tile.categories).toHaveLength(MATRIX_SIZE * MATRIX_SIZE);
  expect(tile.matched).toBe(counts.matched);
  expect(tile.mismatched).toBe(counts.mismatched);
  expect(tile.missing).toBe(counts.missing);
  expect(tile.other).toBe(0);
  expect(tile.matched + tile.mismatched + tile.missing).toBe(MATRIX_SIZE * MATRIX_SIZE);
}

async function setPlotCssSize(page: Page, size: number): Promise<void> {
  await page.evaluate((nextSize) => {
    let style = document.querySelector<HTMLStyleElement>("#exact-render-test-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "exact-render-test-style";
      document.head.append(style);
    }
    style.textContent = `
      #plot-canvas {
        width: ${nextSize}px !important;
        height: ${nextSize}px !important;
      }
      #plot-frame > :not(#plot-canvas) {
        display: none !important;
      }
    `;
  }, size);
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  await expect.poll(async () => page.locator("#plot-canvas").evaluate((element) => ({
    cssWidth: element.getBoundingClientRect().width,
    cssHeight: element.getBoundingClientRect().height,
    width: (element as HTMLCanvasElement).width,
    height: (element as HTMLCanvasElement).height,
  }))).toEqual({
    cssWidth: size,
    cssHeight: size,
    width: size * devicePixelRatio,
    height: size * devicePixelRatio,
  });
  await waitForTwoFrames(page);
}

async function waitForTwoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function unobscuredCanvasScreenshot(page: Page): Promise<Buffer> {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll<HTMLElement>("#plot-frame > :not(#plot-canvas)")) {
      element.style.setProperty("display", "none", "important");
    }
  });
  await waitForTwoFrames(page);
  return page.locator("#plot-canvas").screenshot({ animations: "disabled" });
}

async function captureCategoricalCanvas(
  page: Page,
  colors: ReadonlyMap<string, number>,
): Promise<{ width: number; height: number; digest: string }> {
  const png = decodePng(await unobscuredCanvasScreenshot(page));
  expectOnlyColors(png, new Set(colors.keys()));
  const categories = sampleCellCenters(png, colors);
  return {
    width: png.width,
    height: png.height,
    digest: categoricalDigest(categories),
  };
}

function sampleCellCenters(png: DecodedPng, colors: ReadonlyMap<string, number>): number[] {
  const categories: number[] = [];
  // PNG rows run top-to-bottom while exact tile rows run bottom-to-top. Reverse the
  // sampled rows so screenshot and worker digests describe the same matrix order.
  for (let tileY = 0; tileY < MATRIX_SIZE; tileY += 1) {
    const screenshotY = MATRIX_SIZE - 1 - tileY;
    const pixelY = Math.min(
      png.height - 1,
      Math.floor((screenshotY + 0.5) * png.height / MATRIX_SIZE),
    );
    for (let tileX = 0; tileX < MATRIX_SIZE; tileX += 1) {
      const pixelX = Math.min(
        png.width - 1,
        Math.floor((tileX + 0.5) * png.width / MATRIX_SIZE),
      );
      const key = pixelKey(png.rgba, (pixelY * png.width + pixelX) * 4);
      const category = colors.get(key);
      if (category === undefined) throw new Error(`Unexpected cell-center color ${key}`);
      categories.push(category);
    }
  }
  return categories;
}

function expectOnlyColors(png: DecodedPng, expected: ReadonlySet<string>): void {
  const observed = new Set<string>();
  const unexpectedAlpha = new Set<number>();
  for (let offset = 0; offset < png.rgba.length; offset += 4) {
    const alpha = png.rgba[offset + 3] ?? -1;
    if (alpha !== 255) unexpectedAlpha.add(alpha);
    observed.add(pixelKey(png.rgba, offset));
  }
  expect([...unexpectedAlpha]).toEqual([]);
  expect([...observed].sort()).toEqual([...expected].sort());
}

function pixelKey(pixels: Uint8Array, offset: number): string {
  const color: Rgb = [pixels[offset] ?? -1, pixels[offset + 1] ?? -1, pixels[offset + 2] ?? -1];
  return color.join(",");
}

function categoricalDigest(categories: readonly number[]): string {
  return createHash("sha256").update(Uint8Array.from(categories)).digest("hex");
}

function decodePng(png: Buffer): DecodedPng {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((value, index) => png[index] !== value)) {
    throw new Error("Screenshot is not a PNG");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new Error(`Truncated PNG chunk ${type}`);
    if (type === "IHDR") {
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      bitDepth = png[dataStart + 8] ?? 0;
      colorType = png[dataStart + 9] ?? 0;
      interlace = png[dataStart + 12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(png.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) throw new Error("PNG has no valid dimensions");
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG layout: depth=${bitDepth}, interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new Error(`Unsupported PNG color type ${colorType}`);

  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expectedLength = height * (stride + 1);
  if (packed.length !== expectedLength) {
    throw new Error(`Unexpected PNG payload length ${packed.length}; expected ${expectedLength}`);
  }
  const decoded = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = packed[y * (stride + 1)] ?? -1;
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = packed[source + x] ?? 0;
      const left = x >= channels ? decoded[target + x - channels] ?? 0 : 0;
      const above = y > 0 ? decoded[target + x - stride] ?? 0 : 0;
      const upperLeft = y > 0 && x >= channels
        ? decoded[target + x - stride - channels] ?? 0
        : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? above
            : filter === 3
              ? Math.floor((left + above) / 2)
              : filter === 4
                ? paeth(left, above, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(predictor)) throw new Error(`Unsupported PNG row filter ${filter}`);
      decoded[target + x] = (raw + predictor) & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (colorType === 6) {
      rgba.set(decoded.subarray(source, source + 4), target);
    } else if (colorType === 2) {
      rgba.set(decoded.subarray(source, source + 3), target);
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      rgba[target] = decoded[source] ?? 0;
      rgba[target + 1] = decoded[source] ?? 0;
      rgba[target + 2] = decoded[source] ?? 0;
      rgba[target + 3] = decoded[source + 1] ?? 0;
    } else {
      rgba[target] = decoded[source] ?? 0;
      rgba[target + 1] = decoded[source] ?? 0;
      rgba[target + 2] = decoded[source] ?? 0;
      rgba[target + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}
