import { afterEach, expect, test, vi } from "vitest";
import {
  MAX_IMPORTED_ANNOTATION_BYTES,
  MAX_IMPORTED_ANNOTATION_RECORDS,
  type TrackImportReport,
  type TrackParserMessage,
  type TrackParserRequest,
} from "../src/imported-track-types";

const RUN_SCALE_TEST = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env?.MODDOTPLOT_ANNOTATION_SCALE === "1";
const MAX_PARSE_AND_CLONE_MS = 10_000;
const MAX_ESTIMATED_RETAINED_BYTES = 256 * 1024 * 1024;

afterEach(() => vi.unstubAllGlobals());

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
