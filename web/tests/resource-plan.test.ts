import { describe, expect, it } from "vitest";
import {
  RESOURCE_BUDGETS,
  decideResourceAdmission,
  totalResourceBytes,
  type ResourceUsage,
} from "../src/resource-plan";

const empty: ResourceUsage = {
  wasm: 0,
  jsTiles: 0,
  gpuTextures: 0,
  annotations: 0,
  featureTracks: 0,
  transientPublication: 0,
};

describe("cross-layer resource admission", () => {
  it("selects the declared pre-allocation fallback for each layer", () => {
    expect(decideResourceAdmission(empty, "wasm", RESOURCE_BUDGETS.wasm + 1).action)
      .toBe("downgrade");
    expect(decideResourceAdmission(empty, "jsTiles", RESOURCE_BUDGETS.jsTiles + 1).action)
      .toBe("evict");
    expect(decideResourceAdmission(empty, "gpuTextures", RESOURCE_BUDGETS.gpuTextures + 1).action)
      .toBe("evict");
    expect(decideResourceAdmission(empty, "annotations", RESOURCE_BUDGETS.annotations + 1).action)
      .toBe("reject");
    expect(
      decideResourceAdmission(empty, "transientPublication", RESOURCE_BUDGETS.transientPublication + 1).action,
    ).toBe("shard");
  });

  it("admits bounded requests and reports an actionable total-budget rejection", () => {
    expect(decideResourceAdmission(empty, "wasm", 1024).action).toBe("admit");
    const nearlyFull = { ...empty, wasm: RESOURCE_BUDGETS.total - 512 };
    const rejected = decideResourceAdmission(nearlyFull, "featureTracks", 1024);
    expect(rejected.action).toBe("reject");
    expect(rejected.fallback).toContain("Reduce plot resolution");
  });

  it("keeps representative haploid and diploid human envelopes inside the total plan", () => {
    const haploid: ResourceUsage = {
      wasm: 2 * 1024 * 1024 * 1024,
      jsTiles: 64 * 1024 * 1024,
      gpuTextures: 64 * 1024 * 1024,
      annotations: 256 * 1024 * 1024,
      featureTracks: 32 * 1024 * 1024,
      transientPublication: 176_000_000,
    };
    const diploid: ResourceUsage = {
      ...haploid,
      wasm: RESOURCE_BUDGETS.wasm,
      annotations: RESOURCE_BUDGETS.annotations,
    };
    for (const usage of [haploid, diploid]) {
      expect(totalResourceBytes(usage)).toBeLessThanOrEqual(RESOURCE_BUDGETS.total);
      for (const resource of Object.keys(usage) as Array<keyof ResourceUsage>) {
        expect(usage[resource]).toBeLessThanOrEqual(RESOURCE_BUDGETS[resource]);
      }
    }
  });
});
