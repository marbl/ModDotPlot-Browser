import { describe, expect, it } from "vitest";
import {
  REFINEMENT_POLICY_VERSION,
  refinementKey,
  refinementPriority,
  selectRefinementTiles,
  summarizeRefinementEvidence,
} from "../src/refinement";

describe("display-aware refinement", () => {
  it("has independently versioned scheduler provenance", () => {
    expect(REFINEMENT_POLICY_VERSION).toBe(2);
  });

  it("scores the active display boundary and adequate support statistics", () => {
    const evidence = summarizeRefinementEvidence(
      new Uint16Array([8_450, 8_500, 8_550, 8_600, 0xffff]),
      new Uint16Array([20, 2, 20, 20, 0]),
    );
    expect(evidence.minimumIdentity).toBe(8_450);
    expect(evidence.maximumIdentity).toBe(8_600);
    expect(evidence.nonMissingCells).toBe(4);
    expect(evidence.missingCells).toBe(1);
    expect(evidence.identityHistogram[85]).toBe(2);
    expect(evidence.lowSupportHistogram[85]).toBe(1);
    expect(refinementPriority(evidence, 8_500)).toBeGreaterThan(1);
    expect(refinementPriority(evidence, 9_900)).toBeLessThan(1);
  });

  it("includes uncertain tiles, neighbors, and deterministic blank exploration", () => {
    const tiles = Array.from({ length: 16 }, (_, index) => ({
      x: (index % 4) * 256,
      y: Math.floor(index / 4) * 256,
    }));
    const evidence = new Map([
      [refinementKey(1_024, 256, 256), summarizeRefinementEvidence(
        new Uint16Array([8_400, 8_600]),
        new Uint16Array([12, 12]),
      )],
    ]);
    const selected = selectRefinementTiles(1_024, tiles, evidence, {
      displayMinimum: 8_500,
      refineAll: false,
    });
    expect(selected[0]).toEqual({ x: 256, y: 256 });
    expect(selected).toContainEqual({ x: 0, y: 0 });
    expect(selected).toContainEqual({ x: 512, y: 512 });
    expect(selected.length).toBeLessThan(tiles.length);
  });

  it("retains an explicit all-detail validation mode", () => {
    const tiles = [{ x: 0, y: 0 }, { x: 256, y: 0 }];
    expect(selectRefinementTiles(512, tiles, new Map(), {
      displayMinimum: 8_500,
      refineAll: true,
    })).toEqual(tiles);
  });
});
