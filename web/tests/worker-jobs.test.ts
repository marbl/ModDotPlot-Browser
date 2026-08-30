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

  it("marks every job cancelled synchronously within the 25 ms release limit", () => {
    const jobs = Array.from({ length: 10_000 }, (_, requestId) =>
      new FeatureJob(1, requestId));
    const started = performance.now();
    for (const job of jobs) job.cancel("zoom churn");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(25);
    expect(jobs.every((job) => job.signal.aborted)).toBe(true);
  });
});
