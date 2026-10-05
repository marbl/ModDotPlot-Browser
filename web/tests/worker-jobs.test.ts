import { describe, expect, it } from "vitest";
import {
  ComparisonJob,
  DatasetSession,
  FeatureJob,
  SerializedWorkerQueue,
} from "../src/worker-jobs";

const parameters = {
  xIndex: 0,
  yIndex: 1,
  resolution: 512,
  previewRegisterCount: 256,
  detailedRegisterCount: 1_024,
  k: 21,
  exactGeometry: "footprints" as const,
};

describe("owned worker jobs", () => {
  it("uses immutable identities and rejects stale publication", () => {
    const dataset = new DatasetSession(7);
    const comparison = new ComparisonJob(7, 11, parameters);
    const feature = new FeatureJob(7, 13);
    expect(new Set([dataset.id, comparison.id, feature.id]).size).toBe(3);
    expect(Object.isFrozen(comparison.parameters)).toBe(true);
    expect(comparison.canPublish(7, 11)).toBe(true);
    expect(comparison.canPublish(7, 12)).toBe(false);
    comparison.cancel("superseded");
    expect(comparison.canPublish(7, 11)).toBe(false);
  });

  it("keeps a dataset available to later comparison generations until replacement", () => {
    const dataset = new DatasetSession(3);
    expect(dataset.canPublish(3)).toBe(true);
    expect(dataset.canPublish(4)).toBe(false);
    expect(dataset.canServe()).toBe(true);
    dataset.cancel("replaced");
    expect(dataset.canServe()).toBe(false);
  });

  it("aborts superseded tile I/O without cancelling the reusable comparison", () => {
    const comparison = new ComparisonJob(7, 11, parameters);
    const preparationSignal = comparison.tileSignal;

    comparison.cancelTileRequest(12);
    expect(preparationSignal.aborted).toBe(true);
    expect(comparison.signal.aborted).toBe(false);
    expect(comparison.canPublish(7, 12)).toBe(false);

    comparison.beginTileRequest(13);
    expect(comparison.tileSignal).not.toBe(preparationSignal);
    expect(comparison.tileSignal.aborted).toBe(false);
    expect(comparison.canPublish(7, 13)).toBe(true);
  });

  it("serializes revisions without allowing an old turn to publish", () => {
    const queue = new SerializedWorkerQueue();
    const first = queue.invalidate();
    queue.begin(first);
    expect(queue.isCurrent()).toBe(true);
    const second = queue.invalidate();
    expect(queue.isCurrent()).toBe(false);
    queue.begin(second);
    expect(queue.isCurrent()).toBe(true);
  });

  it("rejects every stale publication in randomized replacement sequences", () => {
    let state = 0x243f6a88;
    const random = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    let active: ComparisonJob | null = null;
    const retired: ComparisonJob[] = [];
    for (let step = 0; step < 2_000; step += 1) {
      if (!active || random() % 3 === 0) {
        active?.cancel("random replacement");
        if (active) retired.push(active);
        const generation = random() % 23;
        const requestId = random();
        active = new ComparisonJob(generation, requestId, parameters);
      } else {
        active.activeTileRequestId = random();
      }
      expect(active.canPublish(active.generation, active.activeTileRequestId)).toBe(true);
      for (const stale of retired.slice(-8)) {
        expect(stale.canPublish(stale.generation, stale.activeTileRequestId)).toBe(false);
      }
    }
  });

  it("marks every job cancelled synchronously within the per-job stress budget", () => {
    const jobs = Array.from({ length: 10_000 }, (_, requestId) =>
      new FeatureJob(1, requestId));
    const started = performance.now();
    for (const job of jobs) job.cancel("zoom churn");
    const elapsed = performance.now() - started;
    // A per-job bound keeps this release gate meaningful without coupling it to
    // transient scheduler load on shared CI hosts. The browser normally owns only
    // a handful of active jobs, while this test deliberately cancels 10,000.
    expect(elapsed / jobs.length).toBeLessThan(0.01);
    expect(jobs.every((job) => job.signal.aborted)).toBe(true);
  });
});
