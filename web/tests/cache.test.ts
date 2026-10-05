import { describe, expect, it } from "vitest";
import { selectTileEvictionCandidate, type CacheCandidate } from "../src/cache";

function candidate(
  key: string,
  resolution: number,
  lastUsed: number,
  visible = false,
): CacheCandidate {
  return { key, resolution, lastUsed, visible };
}

describe("renderer cache eviction", () => {
  it("evicts the oldest offscreen detail before visible active and fallback tiles", () => {
    const selected = selectTileEvictionCandidate([
      candidate("overview", 1_000, 1, true),
      candidate("old-offscreen", 4_000, 2),
      candidate("fallback", 4_000, 3, true),
      candidate("active", 8_000, 4, true),
      candidate("new-offscreen", 8_000, 5),
    ], 1_000, 8_000);

    expect(selected?.key).toBe("old-offscreen");
  });

  it("retains the overview and all tiles required to avoid a blank viewport", () => {
    const selected = selectTileEvictionCandidate([
      candidate("overview", 1_000, 1, true),
      candidate("fallback", 4_000, 2, true),
      candidate("active", 8_000, 3, true),
    ], 1_000, 8_000);

    expect(selected).toBeNull();
  });
});
