#!/usr/bin/env node

import playwright from "../web/node_modules/@playwright/test/index.js";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename, resolve } from "node:path";

const [chm13Argument, hg002Argument, url = "http://127.0.0.1:4174"] = process.argv.slice(2);
const { chromium } = playwright;
if (!chm13Argument || !hg002Argument) {
  console.error("usage: scripts/benchmark-browser.mjs CHM13_CHR1_FASTA HG002_PAT_CHR1_FASTA [URL]");
  process.exit(2);
}

const chm13 = resolve(chm13Argument);
const hg002 = resolve(hg002Argument);
for (const path of [chm13, hg002]) statSync(path);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const unexpectedRequests = [];
page.on("request", (request) => {
  const target = new URL(request.url());
  if (
    (target.protocol === "http:" || target.protocol === "https:")
    && target.origin !== new URL(url).origin
  ) {
    unexpectedRequests.push(request.url());
  }
});
await page.addInitScript(() => {
  const NativeWorker = window.Worker;
  window.__moddotplotBenchmark = { origin: 0, events: [] };
  window.Worker = class ObservedWorker extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        const state = window.__moddotplotBenchmark;
        if (!state || !event.data || typeof event.data.type !== "string") return;
        const message = event.data;
        const record = { tMs: performance.now() - state.origin, type: message.type };
        for (const field of [
          "text", "progress", "busy", "generation", "requestId", "quality", "resolution",
          "x", "y", "width", "height", "elapsedMs", "estimatedBytes",
        ]) {
          if (field in message) record[field] = message[field];
        }
        if (message.type === "comparison-ready") record.parameters = message.parameters;
        state.events.push(record);
      });
    }
  };
});

await page.goto(url);
await page.locator("#resolution").selectOption("1000", { force: true });
await page.locator("#preview-register-count").selectOption("256", { force: true });
await page.locator("#detailed-register-count").selectOption("1024", { force: true });

const self = await benchmarkComparison([chm13], false);
await page.locator("#clear-button").click();
const pairwise = await benchmarkComparison([chm13, hg002], true);
const cacheTrace = await runCacheTrace();
const cancellation = await benchmarkCancellation();
const packageMetadata = JSON.parse(readFileSync(new URL("../web/package.json", import.meta.url)));

const result = {
  generatedAt: new Date().toISOString(),
  software: {
    version: packageMetadata.version,
    commit: git("rev-parse", "HEAD"),
    worktreeDirty: git("status", "--porcelain").length > 0,
  },
  host: {
    platform: platform(),
    release: release(),
    architecture: arch(),
    processor: cpus()[0]?.model ?? "unknown",
    logicalCores: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  browser: await browser.version(),
  viewport: { width: 1440, height: 1000 },
  parameters: {
    overviewResolution: 1_000,
    previewRegisters: 256,
    detailedRegisters: 1_024,
    k: 21,
  },
  inputs: {
    chm13: await fileMetadata(chm13),
    hg002Paternal: await fileMetadata(hg002),
  },
  self,
  pairwise,
  cacheTrace,
  cancellation,
  unexpectedRequests,
};

console.log(JSON.stringify(result, null, 2));
await browser.close();

async function benchmarkComparison(paths, selectPairwise) {
  await resetObservations();
  const start = performance.now();
  await page.locator("#file-input").setInputFiles(paths);
  await page.waitForFunction(
    (count) => document.querySelectorAll("#x-sequence option").length >= count,
    paths.length,
    { timeout: 120_000 },
  );
  const loadMs = performance.now() - start;
  if (selectPairwise) {
    await resetObservations();
    await page.locator("#y-sequence").selectOption("1");
  }
  await page.waitForFunction(() => {
    const state = window.__moddotplotBenchmark;
    return state?.events.some((event) => event.type === "complete");
  }, undefined, { timeout: 180_000 });
  const events = await observations();
  const firstPreview = events.find((event) => event.type === "tile" && event.quality === "preview");
  const previewComplete = events.find((event) => event.type === "preview-complete");
  const firstRefined = events.find((event) => event.type === "tile" && event.quality === "refined");
  const complete = [...events].reverse().find((event) => event.type === "complete");
  return {
    sequenceLoadMs: Math.round(loadMs),
    firstPreviewTileMs: rounded(firstPreview?.tMs),
    coherentPreviewMs: rounded(previewComplete?.tMs),
    firstRefinedTileMs: rounded(firstRefined?.tMs),
    stableViewportMs: rounded(complete?.tMs),
    workerElapsedMs: rounded(complete?.elapsedMs),
    finalMemoryText: await page.locator("#memory-usage").textContent(),
    wasmEstimatedBytes: complete?.estimatedBytes ?? null,
    jsHeapBytes: await chromiumHeapBytes(),
  };
}

async function runCacheTrace() {
  const canvas = page.locator("#plot-canvas");
  await canvas.focus();
  const cycles = [];
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const samples = [];
    for (const key of ["+", "+", "+", "ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown"]) {
      await page.keyboard.press(key);
      await waitForIdle();
      samples.push(await page.locator("#memory-usage").textContent());
    }
    await page.locator("#reset-view").click();
    await waitForIdle();
    samples.push(await page.locator("#memory-usage").textContent());
    cycles.push(samples);
  }
  return { cycles };
}

async function benchmarkCancellation() {
  await page.locator("details").evaluate((element) => { element.open = true; });
  await resetObservations();
  await page.locator("#detailed-register-count").selectOption("4096");
  await page.waitForFunction(() => document.querySelector("#status")?.textContent
    ?.includes("Building high-detail signatures"), undefined, { timeout: 180_000 });
  await resetObservations();
  const canvas = page.locator("#plot-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("plot canvas has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -1_100);
  await page.waitForFunction(() => window.__moddotplotBenchmark?.events.some(
    (event) => event.type === "tile" && event.quality === "preview" && event.resolution > 1_000,
  ), undefined, { timeout: 180_000 });
  const events = await observations();
  const first = events.find(
    (event) => event.type === "tile" && event.quality === "preview" && event.resolution > 1_000,
  );
  return {
    firstReplacementPreviewMs: rounded(first?.tMs),
    replacementResolution: first?.resolution ?? null,
  };
}

async function resetObservations() {
  await page.evaluate(() => {
    window.__moddotplotBenchmark.origin = performance.now();
    window.__moddotplotBenchmark.events = [];
  });
}

async function observations() {
  return page.evaluate(() => window.__moddotplotBenchmark.events);
}

async function chromiumHeapBytes() {
  return page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
}

async function waitForIdle() {
  // Let the viewport debounce replace the preceding Ready state before waiting for idle.
  await page.waitForTimeout(180);
  await page.waitForFunction(() => {
    const text = document.querySelector("#status")?.textContent ?? "";
    const progress = document.querySelector("#compute-progress");
    return text.startsWith("Ready") && progress?.hasAttribute("hidden");
  }, undefined, { timeout: 180_000 });
}

async function fileMetadata(path) {
  return { name: basename(path), bytes: statSync(path).size, sha256: await sha256(path) };
}

function rounded(value) {
  return typeof value === "number" ? Math.round(value) : null;
}

function git(...arguments_) {
  return execFileSync("git", arguments_, { encoding: "utf8" }).trim();
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
