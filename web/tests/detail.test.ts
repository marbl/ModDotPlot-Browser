import { describe, expect, it } from "vitest";
import { selectDetailResolution, selectTiles } from "../src/detail";
import { initialViewport, zoomAt } from "../src/viewport";

describe("demand-driven detail selection", () => {
  it("snaps display demand upward and caps it at one interval per base", () => {
    const base = initialViewport(1000, 0.001);
    expect(selectDetailResolution(1000, 249_000_000, base, 850, 850)).toBe(1000);
    expect(selectDetailResolution(1000, 249_000_000, base, 1400, 1400)).toBe(1000);
    const zoomed = zoomAt(base, 0.2, 0.5, 0.5);
    expect(selectDetailResolution(1000, 249_000_000, zoomed, 850, 850)).toBe(8000);
    expect(selectDetailResolution(1000, 6000, zoomed, 850, 850)).toBe(6000);
    expect(selectDetailResolution(500, 500, initialViewport(500), 850, 850)).toBe(500);
  });

  it("orders visible tiles before unique neighboring tiles", () => {
    const view = { ...initialViewport(1000), x: 250, y: 250, width: 250, height: 250 };
    const tiles = selectTiles(4000, 1000, view, 256, 1);
    expect(tiles[0]).toEqual({ x: 768, y: 768 });
    expect(tiles.slice(0, 25)).toHaveLength(25);
    expect(new Set(tiles.map((tile) => `${tile.x}:${tile.y}`)).size).toBe(tiles.length);
    expect(tiles).toContainEqual({ x: 512, y: 512 });
  });
});
