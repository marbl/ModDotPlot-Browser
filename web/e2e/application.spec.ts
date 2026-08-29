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

function reverseComplement(sequence: string): string {
  const complements: Record<string, string> = { A: "T", C: "G", G: "C", T: "A" };
  return [...sequence].reverse().map((base) => complements[base] ?? "N").join("");
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
  expect(unexpectedRequests).toEqual([]);
});

test("a newer load transaction wins and clear rejects stale publication", async ({ page }) => {
  await page.goto("/");
  const large = `>stale\n${"ACGT".repeat(300_000)}\n`;
  await loadFasta(page, "stale.fa", large);
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
  expect(layout.yAxisWidth).toBeGreaterThanOrEqual(110);
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);

  const gradient = page.locator("#heatmap-gradient");
  const initialGradient = await gradient.evaluate((element) => element.style.backgroundImage);
  await page.locator("#heatmap-palette").selectOption("spectral");
  const spectralGradient = await gradient.evaluate((element) => element.style.backgroundImage);
  expect(spectralGradient).not.toBe(initialGradient);

  await page.locator("#dark-background").check();
  await expect(page.locator("#plot-frame")).toHaveClass(/dark-background/);
  await expect.poll(() => gradient.evaluate((element) => element.style.backgroundImage))
    .toContain("rgb(5, 5, 6)");
  await expect(page.locator("#status")).toContainText("Ready");
});
