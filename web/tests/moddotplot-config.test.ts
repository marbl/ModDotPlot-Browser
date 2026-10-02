import { describe, expect, it } from "vitest";
import {
  createModDotPlotCliConfig,
  paletteBreakpoints,
  type ModDotPlotConfigContext,
} from "../src/moddotplot-config";
import type { SequenceMetadata } from "../src/protocol";

const sequences: SequenceMetadata[] = [
  { index: 0, name: "Chr1", description: "Chr1", length: 1_000, sourceFile: "plant.fa", selectionId: "Chr1_plant" },
  { index: 1, name: "Chr2", description: "Chr2", length: 600, sourceFile: "plant.fa", selectionId: "Chr2_plant" },
];

function context(): ModDotPlotConfigContext {
  return {
    appVersion: "0.9.5",
    baseName: "moddotplot-Chr1-vs-Chr2",
    plotMode: "pairwise" as const,
    sequences,
    gridSequenceIndices: [0, 1],
    parameters: {
      xIndex: 0,
      yIndex: 1,
      resolution: 100,
      previewRegisterCount: 64,
      detailedRegisterCount: 256,
      k: 21,
      exactGeometry: "footprints",
    },
    domainLength: 1_000,
    currentResolution: 200,
    viewport: { x: 10, y: 20, width: 50, height: 30, domain: 100, minSize: 1 },
    palette: "Spectral",
    paletteReversed: true,
    paletteColors: ["#123456", "#abcdef", "#fedcba"],
    heatmapRange: { minimum: 85, midpoint: 91, maximum: 100 },
    colorMode: "similarity" as const,
  };
}

describe("official ModDotPlot CLI config export", () => {
  it("maps pairwise sequence, viewport, cell size, and display settings", () => {
    const config = createModDotPlotCliConfig(context());
    expect(config.load).toEqual(["./moddotplot-Chr1-vs-Chr2.bedpe"]);
    expect(config).not.toHaveProperty("fasta");
    expect(config.sequence).toEqual(["Chr1", "Chr2"]);
    expect(config.region).toEqual(["Chr1:101-600", "Chr2:201-500"]);
    expect(config.window).toBe(21);
    expect(config.compare_only).toBe(true);
    expect(config.grid_only).toBe(false);
    expect(config.palette).toBe("Spectral_3");
    expect(config.colors).toEqual(["#123456", "#abcdef", "#fedcba"]);
    expect(config.breakpoints).toEqual([85, 89, 94, 100]);
    expect(config.identity).toBe(config.breakpoints[0]);
    expect(config._moddotplot_browser.requested_bp_per_cell).toBe(5);
    expect(config._moddotplot_browser.command).toBe(
      "moddotplot -c moddotplot-Chr1-vs-Chr2.config.json -l moddotplot-Chr1-vs-Chr2.bedpe",
    );
  });

  it("exports one union region for an asymmetric self view", () => {
    const input = context();
    input.plotMode = "self";
    input.parameters.yIndex = 0;
    const config = createModDotPlotCliConfig(input);
    expect(config.sequence).toEqual(["Chr1"]);
    expect(config.region).toEqual(["Chr1:101-600"]);
    expect(config.compare_only).toBe(false);
  });

  it("preserves grid ordering and references the companion BEDPE", () => {
    const input = context();
    input.plotMode = "grid";
    input.gridSequenceIndices = [1, 0];
    const config = createModDotPlotCliConfig(input);
    expect(config.sequence).toEqual(["Chr2", "Chr1"]);
    expect(config.load).toEqual(["./moddotplot-Chr1-vs-Chr2.bedpe"]);
    expect(config.region).toBeUndefined();
    expect(config.grid_only).toBe(true);
  });

  it("emits one more breakpoint than color and anchors at min, midpoint, max", () => {
    expect(paletteBreakpoints({ minimum: 80, midpoint: 90, maximum: 100 }, 4))
      .toEqual([80, 85, 90, 95, 100]);
  });

  it("keeps official CLI breakpoints strictly increasing for collapsed browser ranges", () => {
    expect(paletteBreakpoints({ minimum: 100, midpoint: 100, maximum: 100 }, 3))
      .toEqual([100, 100.0001, 100.0002, 100.0003]);
    expect(paletteBreakpoints({ minimum: 85, midpoint: 85, maximum: 100 }, 3))
      .toEqual([85, 90, 95, 100]);
  });
});
