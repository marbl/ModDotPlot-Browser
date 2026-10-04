import { describe, expect, it } from "vitest";
import {
  GridPairRenderer,
  directionColorRgba,
} from "../src/grid-renderer";
import { identityColorRgba } from "../src/heatmap";
import type { MatrixTilePayload } from "../src/protocol";

class RecordingContext {
  image: ImageData | null = null;

  createImageData(width: number, height: number): ImageData {
    return {
      width,
      height,
      colorSpace: "srgb",
      data: new Uint8ClampedArray(width * height * 4),
    } as ImageData;
  }

  putImageData(image: ImageData): void {
    this.image = image;
  }
}

function fakeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  context: RecordingContext;
} {
  const context = new RecordingContext();
  return {
    canvas: {
      width,
      height,
      getContext: (kind: string) => kind === "2d" ? context : null,
    } as unknown as HTMLCanvasElement,
    context,
  };
}

function tile(
  identity: readonly number[],
  options: Partial<MatrixTilePayload> = {},
): MatrixTilePayload {
  const width = options.width ?? identity.length;
  const height = options.height ?? 1;
  return {
    generation: options.generation ?? 1,
    configDigest: options.configDigest ?? "config",
    quality: options.quality ?? "preview",
    resolution: options.resolution ?? Math.max(width, height),
    x: options.x ?? 0,
    y: options.y ?? 0,
    width,
    height,
    identity: new Uint16Array(identity),
    direction: options.direction ?? new Int16Array(identity.length),
    directionSupport: options.directionSupport ?? new Uint16Array(identity.length),
    bases: options.bases,
  };
}

function pixel(context: RecordingContext, x: number, y: number): number[] {
  const image = context.image;
  if (!image) throw new Error("canvas was not painted");
  const offset = (y * image.width + x) * 4;
  return [...image.data.slice(offset, offset + 4)];
}

describe("grid pair renderer", () => {
  const range = { minimum: 85, midpoint: 92, maximum: 100 };

  it("keeps matrix row zero at the bottom and paints the optional pair transpose", () => {
    const normal = fakeCanvas(2, 2);
    const mirrored = fakeCanvas(2, 2);
    const renderer = new GridPairRenderer(normal.canvas, mirrored.canvas);
    renderer.setHeatmapPalette("Spectral", 5);
    renderer.addTile(tile(
      [8_500, 9_200, 10_000, 9_000],
      { resolution: 2, width: 2, height: 2 },
    ));

    const colors = [8_500, 9_200, 10_000, 9_000].map(
      (identity) => [...identityColorRgba(identity, "Spectral", range, false, 5)],
    );
    expect([
      pixel(normal.context, 0, 0),
      pixel(normal.context, 1, 0),
      pixel(normal.context, 0, 1),
      pixel(normal.context, 1, 1),
    ]).toEqual([colors[2], colors[3], colors[0], colors[1]]);
    expect([
      pixel(mirrored.context, 0, 0),
      pixel(mirrored.context, 1, 0),
      pixel(mirrored.context, 0, 1),
      pixel(mirrored.context, 1, 1),
    ]).toEqual([colors[1], colors[3], colors[0], colors[2]]);
  });

  it("transposes a non-square tile at an offset without shifting its edge cells", () => {
    const normal = fakeCanvas(4, 4);
    const mirrored = fakeCanvas(4, 4);
    const renderer = new GridPairRenderer(normal.canvas, mirrored.canvas);
    const identities = [8_500, 8_800, 9_100, 9_400, 9_700, 10_000];
    renderer.addTile(tile(identities, {
      resolution: 4,
      x: 1,
      y: 0,
      width: 2,
      height: 3,
    }));
    const colors = identities.map(
      (identity) => [...identityColorRgba(identity, "Spectral", range, false)],
    );

    expect([
      pixel(normal.context, 1, 3),
      pixel(normal.context, 2, 3),
      pixel(normal.context, 1, 2),
      pixel(normal.context, 2, 2),
      pixel(normal.context, 1, 1),
      pixel(normal.context, 2, 1),
    ]).toEqual(colors);
    expect([
      pixel(mirrored.context, 0, 2),
      pixel(mirrored.context, 0, 1),
      pixel(mirrored.context, 1, 2),
      pixel(mirrored.context, 1, 1),
      pixel(mirrored.context, 2, 2),
      pixel(mirrored.context, 2, 1),
    ]).toEqual(colors);
    expect(pixel(normal.context, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(mirrored.context, 3, 3)).toEqual([255, 255, 255, 255]);
  });

  it("anchors a shorter pair at the genomic origin on a shared grid domain", () => {
    const normal = fakeCanvas(4, 4);
    const mirrored = fakeCanvas(4, 4);
    const renderer = new GridPairRenderer(normal.canvas, mirrored.canvas, 0.5);
    renderer.addTile(tile(
      [8_500, 9_200, 10_000, 9_000],
      { resolution: 2, width: 2, height: 2 },
    ));

    const white = [255, 255, 255, 255];
    expect(pixel(normal.context, 0, 2)).not.toEqual(white);
    expect(pixel(normal.context, 1, 3)).not.toEqual(white);
    expect(pixel(mirrored.context, 0, 2)).not.toEqual(white);
    expect(pixel(mirrored.context, 1, 3)).not.toEqual(white);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if (x < 2 && y >= 2) continue;
        expect(pixel(normal.context, x, y)).toEqual(white);
        expect(pixel(mirrored.context, x, y)).toEqual(white);
      }
    }
  });

  it("rejects grid domain scales outside the normalized range", () => {
    const target = fakeCanvas(1, 1);
    for (const scale of [0, -0.5, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new GridPairRenderer(target.canvas, null, scale)).toThrow(/domain scale/);
    }
  });

  it("replaces a coordinate only with equal or better scientific quality", () => {
    const target = fakeCanvas(1, 1);
    const renderer = new GridPairRenderer(target.canvas);
    renderer.setHeatmapPalette("Spectral");
    renderer.addTile(tile([8_500], { resolution: 1, quality: "preview" }));
    renderer.addTile(tile([10_000], { resolution: 1, quality: "refined" }));
    renderer.addTile(tile([9_200], { resolution: 1, quality: "preview" }));

    expect(pixel(target.context, 0, 0)).toEqual(
      [...identityColorRgba(10_000, "Spectral", range, false)],
    );
    expect(renderer.estimatedBytes()).toBe(6);
    expect(renderer.exportTileViews()).toMatchObject([{
      quality: "refined",
      resolution: 1,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }]);

    renderer.clearTiles();
    expect(renderer.estimatedBytes()).toBe(0);
    expect(renderer.exportTileViews()).toEqual([]);
    expect(pixel(target.context, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it("repaints from an explicitly customized palette", () => {
    const target = fakeCanvas(1, 1);
    const renderer = new GridPairRenderer(target.canvas);
    renderer.setHeatmapPalette("Viridis", 3, ["#112233", "#445566", "#abcdef"]);
    renderer.addTile(tile([10_000], { resolution: 1 }));
    expect(pixel(target.context, 0, 0)).toEqual([171, 205, 239, 255]);

    renderer.setHeatmapPalette("Viridis", 3, ["#112233", "#445566", "#fedcba"]);
    expect(pixel(target.context, 0, 0)).toEqual([254, 220, 186, 255]);
  });

  it("matches direction shading and applies range and background changes immediately", () => {
    expect(directionColorRgba(9_200, 32_767, 100, range, false))
      .toEqual([135, 186, 207, 255]);
    expect(directionColorRgba(8_499, -32_767, 100, range, true))
      .toEqual([5, 5, 6, 255]);

    const target = fakeCanvas(1, 1);
    const renderer = new GridPairRenderer(target.canvas);
    renderer.addTile(tile([9_200], {
      resolution: 1,
      direction: new Int16Array([32_767]),
      directionSupport: new Uint16Array([100]),
    }));
    renderer.setColorMode("direction");
    expect(pixel(target.context, 0, 0)).toEqual([135, 186, 207, 255]);

    renderer.setDarkBackground(true);
    renderer.setHeatmapRange(95, 97, 100);
    expect(pixel(target.context, 0, 0)).toEqual([5, 5, 6, 255]);
  });

  it("rejects malformed tiles and releases retained arrays on destroy", () => {
    const target = fakeCanvas(1, 1);
    const renderer = new GridPairRenderer(target.canvas);
    expect(() => renderer.addTile(tile([9_200], {
      resolution: 1,
      direction: new Int16Array(),
    }))).toThrow(/channels or bounds/);

    renderer.addTile(tile([9_200], { resolution: 1 }));
    renderer.destroy();
    expect(renderer.estimatedBytes()).toBe(0);
    expect(() => renderer.addTile(tile([9_200], { resolution: 1 }))).toThrow(/destroyed/);
  });
});
