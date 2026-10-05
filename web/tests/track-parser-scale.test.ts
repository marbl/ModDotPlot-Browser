import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  MAX_IMPORTED_ANNOTATION_BYTES,
  MAX_IMPORTED_ANNOTATION_RECORDS,
  type TrackImportReport,
  type TrackParserMessage,
  type TrackParserRequest,
} from "../src/imported-track-types";
import { decideResourceAdmission, type ResourceUsage } from "../src/resource-plan";

const RUN_SCALE_TEST = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env?.MODDOTPLOT_ANNOTATION_SCALE === "1";
const MAX_PARSE_AND_CLONE_MS = 10_000;
const MAX_ESTIMATED_RETAINED_BYTES = 256 * 1024 * 1024;

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

test("cancels annotation parsing before terminal publication", async () => {
  const file = new File([
    new Array(100_000).fill(0).map((_, index) => `chr1\t${index * 10}\t${index * 10 + 5}`).join("\n"),
  ], "cancel.bed", { type: "text/plain" });
  let workerOnMessage: ((event: MessageEvent<TrackParserRequest>) => void) | null = null;
  let progressSeen = false;
  let terminalSeen = false;
  const worker = {
    onmessage: null as ((event: MessageEvent<TrackParserRequest>) => void) | null,
    postMessage(message: TrackParserMessage) {
      if (message.type === "progress" && !progressSeen) {
        progressSeen = true;
        workerOnMessage?.({
          data: { type: "cancel", requestIds: [7] },
        } as MessageEvent<TrackParserRequest>);
      }
      if (message.type === "complete" || message.type === "error") terminalSeen = true;
    },
  };
  vi.stubGlobal("self", worker);
  await import("../src/track-parser-worker");
  workerOnMessage = worker.onmessage;
  workerOnMessage?.({
    data: {
      type: "parse",
      requestId: 7,
      file,
      targetSequence: { index: 0, name: "chr1", length: 1_000_000 },
    },
  } as MessageEvent<TrackParserRequest>);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(progressSeen).toBe(true);
  expect(terminalSeen).toBe(false);
});

test("batch parsing reads a file once and never duplicates ambiguous aliases", async () => {
  const file = new File([
    [
      "chr1\t0\t10\texact",
      "chr2\t10\t20\tunique-alias",
      "chrMT\t20\t30\tambiguous-alias",
    ].join("\n"),
  ], "batch.bed", { type: "text/plain" });
  const originalStream = file.stream.bind(file);
  let streamCalls = 0;
  Object.defineProperty(file, "stream", {
    value: () => {
      streamCalls += 1;
      return originalStream();
    },
  });
  const completed = new Promise<Extract<TrackParserMessage, { type: "batch-complete" }>>((resolve, reject) => {
    vi.stubGlobal("self", {
      onmessage: null as ((event: MessageEvent<TrackParserRequest>) => void) | null,
      postMessage(message: TrackParserMessage) {
        if (message.type === "error") reject(new Error(message.message));
        if (message.type === "batch-complete") resolve(message);
      },
    });
  });
  await import("../src/track-parser-worker");
  const worker = globalThis.self as unknown as {
    onmessage: (event: MessageEvent<TrackParserRequest>) => void;
  };
  worker.onmessage({
    data: {
      type: "parse-batch",
      requestId: 8,
      file,
      candidates: [
        { axis: "x", index: 0, name: "chr1", length: 100 },
        { axis: "y", index: 1, name: "2", length: 100 },
        { axis: "y", index: 2, name: "MT", length: 100 },
        { axis: "y", index: 3, name: "M", length: 100 },
      ],
    },
  } as MessageEvent<TrackParserRequest>);
  const result = await completed;

  expect(streamCalls).toBe(1);
  expect(result.results.map(({ candidate }) => candidate.index)).toEqual([0, 1]);
  expect(result.results.map(({ report }) => report.matchKind)).toEqual(["exact", "alias"]);
  expect(result.results.reduce((sum, { report }) => sum + report.validRecords, 0)).toBe(2);
  expect(result.ambiguousRecords).toBe(1);
  expect(result.ambiguousIdentifiers).toEqual(["chrMT"]);
});

test.skipIf(!RUN_SCALE_TEST)(
  "parses and publishes a generated million-record BED within the release envelope",
  async () => {
    const lines = new Array<string>(MAX_IMPORTED_ANNOTATION_RECORDS);
    for (let index = 0; index < lines.length; index += 1) {
      const start = index * 10;
      lines[index] = `chr1\t${start}\t${start + 5}`;
    }
    const file = new File([lines.join("\n")], "million-records.bed", { type: "text/plain" });
    expect(file.size).toBeLessThanOrEqual(MAX_IMPORTED_ANNOTATION_BYTES);

    let parseStarted = 0;
    const completed = new Promise<{
      report: TrackImportReport;
      parseAndCloneMs: number;
      cloneMs: number;
    }>((resolve, reject) => {
      const worker = {
        onmessage: null as ((event: MessageEvent<TrackParserRequest>) => void) | null,
        postMessage(message: TrackParserMessage) {
          if (message.type === "error") {
            reject(new Error(message.message));
          } else if (message.type === "complete") {
            const cloneStarted = performance.now();
            const cloned = structuredClone(message.report);
            const cloneMs = performance.now() - cloneStarted;
            resolve({ report: cloned, parseAndCloneMs: performance.now() - parseStarted, cloneMs });
          }
        },
      };
      vi.stubGlobal("self", worker);
    });

    await import("../src/track-parser-worker");
    const worker = globalThis.self as unknown as {
      onmessage: (event: MessageEvent<TrackParserRequest>) => void;
    };
    const request: TrackParserRequest = {
      type: "parse",
      requestId: 1,
      file,
      targetSequence: { index: 0, name: "chr1", length: 10_000_000 },
    };
    parseStarted = performance.now();
    worker.onmessage({ data: request } as MessageEvent<TrackParserRequest>);
    const result = await completed;

    const features = result.report.tracks.flatMap((track) => track.features);
    const estimatedRetainedBytes = features.reduce(
      (total, feature) => total + 160 + feature.blocks.length * 8 + feature.details.join("").length * 2,
      0,
    );
    expect(result.report.validRecords).toBe(MAX_IMPORTED_ANNOTATION_RECORDS);
    expect(features).toHaveLength(MAX_IMPORTED_ANNOTATION_RECORDS);
    expect(result.parseAndCloneMs).toBeLessThanOrEqual(MAX_PARSE_AND_CLONE_MS);
    expect(estimatedRetainedBytes).toBeLessThanOrEqual(MAX_ESTIMATED_RETAINED_BYTES);
    const emptyUsage: ResourceUsage = {
      wasm: 0,
      jsTiles: 0,
      gpuTextures: 0,
      annotations: 0,
      featureTracks: 0,
      transientPublication: 0,
    };
    expect(
      decideResourceAdmission(emptyUsage, "transientPublication", estimatedRetainedBytes).action,
    ).toBe("admit");
    console.log(JSON.stringify({
      records: result.report.validRecords,
      fileBytes: file.size,
      parseAndCloneMs: result.parseAndCloneMs,
      cloneMs: result.cloneMs,
      estimatedRetainedBytes,
    }));
  },
  MAX_PARSE_AND_CLONE_MS + 30_000,
);
