/**
 * Application palette catalog.
 *
 * ColorBrewer remains the source of the categorized ColorBrewer schemes. This
 * facade promotes Spectral to its own first group and adds Viridis as the
 * second group while preserving the original ColorBrewer subcategories.
 *
 * Viridis' 256-color table and sampling behavior follow d3-scale-chromatic:
 * https://github.com/d3/d3-scale-chromatic/blob/main/src/sequential-multi/viridis.js
 */

import {
  COLORBREWER_DIVERGING_PALETTES,
  COLORBREWER_PALETTE_IDS,
  COLORBREWER_PALETTES,
  COLORBREWER_QUALITATIVE_PALETTES,
  COLORBREWER_SEQUENTIAL_PALETTES,
  DEFAULT_COLORBREWER_COLOR_COUNT,
  DEFAULT_COLORBREWER_PALETTE,
  type ColorBrewerPaletteId,
  type PaletteColorCountRange,
} from "./colorbrewer";

export const VIRIDIS_PALETTE_ID = "Viridis" as const;

export type PaletteId = ColorBrewerPaletteId | typeof VIRIDIS_PALETTE_ID;
export type PaletteGroupId =
  | "spectral"
  | "viridis"
  | "sequential"
  | "diverging"
  | "qualitative";

export interface PaletteGroup {
  readonly id: PaletteGroupId;
  readonly label: string;
  readonly paletteIds: readonly PaletteId[];
}

export interface HeatmapPalette {
  readonly id: PaletteId;
  readonly label: string;
  readonly category: PaletteGroupId;
  readonly colorCounts: readonly number[];
  readonly minColors: number;
  readonly maxColors: number;
  readonly defaultColorCount: number;
  readonly colorsByCount: Readonly<Record<number, readonly string[]>>;
}

type ColorBrewerDivergingPaletteId =
  typeof COLORBREWER_DIVERGING_PALETTES[number];
type NonSpectralDivergingPaletteId = Exclude<
  ColorBrewerDivergingPaletteId,
  "Spectral"
>;

const NON_SPECTRAL_DIVERGING_PALETTES = Object.freeze(
  COLORBREWER_DIVERGING_PALETTES.filter(
    (id): id is NonSpectralDivergingPaletteId => id !== "Spectral",
  ),
);

export const PALETTE_GROUPS: readonly PaletteGroup[] = Object.freeze([
  Object.freeze({
    id: "spectral" as const,
    label: "Spectral",
    paletteIds: Object.freeze(["Spectral"] as const),
  }),
  Object.freeze({
    id: "viridis" as const,
    label: "Viridis",
    paletteIds: Object.freeze([VIRIDIS_PALETTE_ID] as const),
  }),
  Object.freeze({
    id: "sequential" as const,
    label: "Sequential",
    paletteIds: Object.freeze([...COLORBREWER_SEQUENTIAL_PALETTES]),
  }),
  Object.freeze({
    id: "diverging" as const,
    label: "Diverging",
    paletteIds: NON_SPECTRAL_DIVERGING_PALETTES,
  }),
  Object.freeze({
    id: "qualitative" as const,
    label: "Qualitative",
    paletteIds: Object.freeze([...COLORBREWER_QUALITATIVE_PALETTES]),
  }),
]);

export const PALETTE_IDS: readonly PaletteId[] = Object.freeze(
  PALETTE_GROUPS.flatMap((group) => group.paletteIds),
);

export const DEFAULT_PALETTE: PaletteId = DEFAULT_COLORBREWER_PALETTE;
export const DEFAULT_PALETTE_COLOR_COUNT = DEFAULT_COLORBREWER_COLOR_COUNT;
export const DEFAULT_PALETTE_REVERSED = true;

// Published as a compact RGB table by d3-scale-chromatic. Its ramp selects
// floor(t * 256), clamped to the final color; buildViridisPalette preserves
// that exact behavior for the application's supported discrete class counts.
const PACKED_VIRIDIS_256 =
  "44015444025645045745055946075a46085c460a5d460b5e470d60470e6147106347116447136548146748166848176948186a481a6c481b6d481c6e481d6f481f70482071482173482374482475482576482677482878482979472a7a472c7a472d7b472e7c472f7d46307e46327e46337f463480453581453781453882443983443a83443b84433d84433e85423f854240864241864142874144874045884046883f47883f48893e49893e4a893e4c8a3d4d8a3d4e8a3c4f8a3c508b3b518b3b528b3a538b3a548c39558c39568c38588c38598c375a8c375b8d365c8d365d8d355e8d355f8d34608d34618d33628d33638d32648e32658e31668e31678e31688e30698e306a8e2f6b8e2f6c8e2e6d8e2e6e8e2e6f8e2d708e2d718e2c718e2c728e2c738e2b748e2b758e2a768e2a778e2a788e29798e297a8e297b8e287c8e287d8e277e8e277f8e27808e26818e26828e26828e25838e25848e25858e24868e24878e23888e23898e238a8d228b8d228c8d228d8d218e8d218f8d21908d21918c20928c20928c20938c1f948c1f958b1f968b1f978b1f988b1f998a1f9a8a1e9b8a1e9c891e9d891f9e891f9f881fa0881fa1881fa1871fa28720a38620a48621a58521a68522a78522a88423a98324aa8325ab8225ac8226ad8127ad8128ae8029af7f2ab07f2cb17e2db27d2eb37c2fb47c31b57b32b67a34b67935b77937b87838b9773aba763bbb753dbc743fbc7340bd7242be7144bf7046c06f48c16e4ac16d4cc26c4ec36b50c46a52c56954c56856c66758c7655ac8645cc8635ec96260ca6063cb5f65cb5e67cc5c69cd5b6ccd5a6ece5870cf5773d05675d05477d1537ad1517cd2507fd34e81d34d84d44b86d54989d5488bd6468ed64590d74393d74195d84098d83e9bd93c9dd93ba0da39a2da37a5db36a8db34aadc32addc30b0dd2fb2dd2db5de2bb8de29bade28bddf26c0df25c2df23c5e021c8e020cae11fcde11dd0e11cd2e21bd5e21ad8e219dae319dde318dfe318e2e418e5e419e7e419eae51aece51befe51cf1e51df4e61ef6e620f8e621fbe723fde725";

const VIRIDIS_COLOR_COUNTS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => index + 3),
);

const VIRIDIS_PALETTE = buildViridisPalette();

const categoryByPalette = new Map<PaletteId, PaletteGroupId>(
  PALETTE_GROUPS.flatMap((group) =>
    group.paletteIds.map((id) => [id, group.id] as const),
  ),
);

const colorBrewerPaletteEntries = COLORBREWER_PALETTE_IDS.map((id) => {
  const category = categoryByPalette.get(id);
  if (!category) {
    throw new Error(`Palette ${id} is missing from the application palette groups.`);
  }
  return [id, cloneColorBrewerPalette(id, category)] as const;
});

export const HEATMAP_PALETTES: Readonly<Record<PaletteId, HeatmapPalette>> =
  Object.freeze({
    ...Object.fromEntries(colorBrewerPaletteEntries),
    [VIRIDIS_PALETTE_ID]: VIRIDIS_PALETTE,
  } as Record<PaletteId, HeatmapPalette>);

const paletteIdSet: ReadonlySet<string> = new Set(PALETTE_IDS);

export function isPaletteId(value: string): value is PaletteId {
  return paletteIdSet.has(value);
}

/** Returns every supported class count for a palette, in ascending order. */
export function paletteColorCounts(palette: PaletteId): readonly number[] {
  return HEATMAP_PALETTES[palette].colorCounts;
}

/** Returns the inclusive bounds for a palette's supported class counts. */
export function paletteColorCountRange(palette: PaletteId): PaletteColorCountRange {
  const definition = HEATMAP_PALETTES[palette];
  return { min: definition.minColors, max: definition.maxColors };
}

/** Returns the largest supported class count for the palette. */
export function paletteDefaultColorCount(palette: PaletteId): number {
  return HEATMAP_PALETTES[palette].defaultColorCount;
}

/** Returns a frozen palette variant and rejects unsupported class counts. */
export function paletteColors(
  palette: PaletteId,
  colorCount: number,
): readonly string[] {
  const definition = HEATMAP_PALETTES[palette];
  const colors = definition.colorsByCount[colorCount];
  if (!colors) {
    throw new RangeError(
      `${palette} supports ${definition.colorCounts.join(", ")} colors; received ${colorCount}.`,
    );
  }
  return colors;
}

function cloneColorBrewerPalette(
  id: ColorBrewerPaletteId,
  category: PaletteGroupId,
): HeatmapPalette {
  const source = COLORBREWER_PALETTES[id];
  const colorsByCount = Object.fromEntries(
    source.colorCounts.map((count) => {
      const colors = source.colorsByCount[count];
      if (!colors) {
        throw new Error(`ColorBrewer palette ${id} is missing its ${count}-color variant.`);
      }
      return [count, Object.freeze([...colors])] as const;
    }),
  );
  return Object.freeze({
    id,
    label: source.label,
    category,
    colorCounts: Object.freeze([...source.colorCounts]),
    minColors: source.minColors,
    maxColors: source.maxColors,
    defaultColorCount: source.defaultColorCount,
    colorsByCount: Object.freeze(colorsByCount),
  });
}

function buildViridisPalette(): HeatmapPalette {
  const sourceColors = unpackColors(PACKED_VIRIDIS_256);
  if (sourceColors.length !== 256) {
    throw new Error(`Viridis must contain 256 source colors; found ${sourceColors.length}.`);
  }
  const colorsByCount = Object.fromEntries(
    VIRIDIS_COLOR_COUNTS.map((colorCount) => [
      colorCount,
      Object.freeze(Array.from({ length: colorCount }, (_, index) => {
        const position = index / (colorCount - 1);
        const sourceIndex = Math.min(
          sourceColors.length - 1,
          Math.floor(position * sourceColors.length),
        );
        const color = sourceColors[sourceIndex];
        if (!color) {
          throw new Error(`Viridis source color ${sourceIndex} is missing.`);
        }
        return color;
      })),
    ]),
  );
  return Object.freeze({
    id: VIRIDIS_PALETTE_ID,
    label: VIRIDIS_PALETTE_ID,
    category: "viridis",
    colorCounts: VIRIDIS_COLOR_COUNTS,
    minColors: 3,
    maxColors: 12,
    defaultColorCount: 12,
    colorsByCount: Object.freeze(colorsByCount),
  });
}

function unpackColors(packed: string): string[] {
  if (packed.length % 6 !== 0 || !/^[0-9a-f]+$/.test(packed)) {
    throw new Error("Packed palette colors must use six lowercase hexadecimal digits.");
  }
  const colors: string[] = [];
  for (let index = 0; index < packed.length; index += 6) {
    colors.push(`#${packed.slice(index, index + 6)}`);
  }
  return colors;
}
