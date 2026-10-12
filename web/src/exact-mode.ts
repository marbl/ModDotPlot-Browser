export const EXACT_KMER_GEOMETRIES = ["footprints", "anchors"] as const;
export type ExactKmerGeometry = typeof EXACT_KMER_GEOMETRIES[number];

export type ExactColorMode = "similarity" | "direction";

export const DEFAULT_EXACT_KMER_GEOMETRY: ExactKmerGeometry = "footprints";

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
  colorMode: ExactColorMode,
): string {
  const color = colorMode === "direction" ? "direction" : "Base";
  return `Exact · 1 bp/cell · canonical ${k}-mers · ${exactGeometryLabel(geometry).toLowerCase()} · color = ${color}`;
}
