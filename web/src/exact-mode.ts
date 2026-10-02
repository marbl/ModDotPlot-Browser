export const EXACT_KMER_GEOMETRIES = ["footprints", "anchors"] as const;
export type ExactKmerGeometry = typeof EXACT_KMER_GEOMETRIES[number];

export const EXACT_VISUALIZATION_MODES = ["identity", "bases"] as const;
export type ExactVisualizationMode = typeof EXACT_VISUALIZATION_MODES[number];

export type ExactColorMode = "similarity" | "direction";

export const DEFAULT_EXACT_KMER_GEOMETRY: ExactKmerGeometry = "footprints";
export const DEFAULT_EXACT_VISUALIZATION: ExactVisualizationMode = "bases";

export function exactConfigDigest(k: number, geometry: ExactKmerGeometry): string {
  return `exact-k${k}-${geometry}`;
}

export function exactTilePublicationKey(
  resolution: number,
  x: number,
  y: number,
  geometry: ExactKmerGeometry,
): string {
  return `${resolution}:${x}:${y}:exact:${geometry}`;
}

export function exactGeometryLabel(geometry: ExactKmerGeometry): string {
  return geometry === "anchors" ? "K-mer anchors" : "Full footprints";
}

export function exactModeBannerText(
  k: number,
  geometry: ExactKmerGeometry,
  visualization: ExactVisualizationMode,
  colorMode: ExactColorMode,
): string {
  const color = colorMode === "direction"
    ? "direction"
    : visualization === "bases"
      ? "Base"
      : "identity";
  return `Exact · 1 bp/cell · canonical ${k}-mers · ${exactGeometryLabel(geometry).toLowerCase()} · color = ${color}`;
}

export function exactIdentityLabel(identity: number | null): string {
  return identity === null ? "no k-mer evidence" : `identity ${identity.toFixed(2)}%`;
}
