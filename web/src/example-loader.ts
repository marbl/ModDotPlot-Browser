import {
  decodePrecomputedOverview,
  decodePrecomputedOverviewGzip,
  type PrecomputedOverviewArtifact,
} from "./precomputed-overview";
import type { RemoteFastaSourceDescriptor } from "./protocol";

export interface BundledExampleAsset {
  readonly fileName: string;
  readonly relativeUrl: string;
  readonly mediaType: string;
  /** Byte length of the checked-in public asset as it is transferred. */
  readonly byteLength: number;
  readonly sha256?: string;
  /** Optional canonical bytes exposed after transparent HTTP content decoding. */
  readonly decodedByteLength?: number;
  readonly decodedSha256?: string;
}

export const ARABIDOPSIS_EXAMPLE_ASSETS = {
  fasta: {
    fileName: "Col-CEN_v1.2.fasta",
    relativeUrl: "examples/Col-CEN_v1.2.fasta",
    mediaType: "text/plain",
    byteLength: 134_282_475,
    sha256: "21c467339262bcc1854492451894241ac1bc31de63c5a1521caeb5439075bcd2",
  },
  fai: {
    fileName: "Col-CEN_v1.2.fasta.fai",
    relativeUrl: "examples/Col-CEN_v1.2.fasta.fai",
    mediaType: "text/plain",
    byteLength: 195,
    sha256: "b2edc0c2d0b9ad4ce2b0b4a7dcdc1a602b3b6604982bea6546e7fcfa94c56c9f",
  },
  overview: {
    fileName: "Col-CEN_v1.2.Chr1.mdp-overview-v1.gz",
    relativeUrl: "examples/Col-CEN_v1.2.Chr1.mdp-overview-v1.gz",
    mediaType: "application/gzip",
    byteLength: 255_582,
    sha256: "cff868954355763b81df5e3ac097120f24d4664213a9005677c27bf9b8dd0d4b",
    decodedByteLength: 6_003_800,
    decodedSha256: "82701ff40df42b075c50dd3d2b60f28be11a35cafe89647d0b3e6201748ebdd0",
  },
  annotation: {
    fileName: "ColCEN_CEN180.gff3",
    relativeUrl: "examples/ColCEN_CEN180.gff3",
    mediaType: "text/plain",
    byteLength: 3_647_621,
    sha256: "5259e53dbcf654d01273f4c4bea40e07c04b1ec3e143453cf1f171e4201281b0",
  },
} as const satisfies Record<string, BundledExampleAsset>;

export interface ArabidopsisExampleStartup {
  source: RemoteFastaSourceDescriptor;
  artifact: PrecomputedOverviewArtifact;
}

export type ExampleAssetFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LoadArabidopsisExampleOptions {
  signal?: AbortSignal;
  /** Reports aggregate progress for only the FAI and precomputed overview. */
  onProgress?: (message: string, progress: number) => void;
  /** Application directory containing the public `examples/` folder. */
  baseUrl?: string | URL;
  /** Injectable for unit tests; production callers normally use `fetch`. */
  fetcher?: ExampleAssetFetcher;
}

export interface LoadArabidopsisAnnotationOptions {
  signal?: AbortSignal;
  onProgress?: (message: string, progress: number) => void;
  baseUrl?: string | URL;
  fetcher?: ExampleAssetFetcher;
}

function defaultApplicationBaseUrl(): string | URL {
  if (typeof document === "undefined") return "/";
  return new URL(".", document.baseURI);
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function resolveExampleAssetUrl(
  asset: BundledExampleAsset,
  baseUrl: string | URL = defaultApplicationBaseUrl(),
): string {
  if (baseUrl instanceof URL) {
    return new URL(asset.relativeUrl, new URL("./", withTrailingSlash(baseUrl.href))).href;
  }

  const normalizedBase = withTrailingSlash(baseUrl);
  try {
    return new URL(asset.relativeUrl, normalizedBase).href;
  } catch {
    return `${normalizedBase}${asset.relativeUrl}`;
  }
}

interface ExampleAssetResponse {
  readonly asset: BundledExampleAsset;
  readonly response: Response;
  readonly progressByteLength: number;
}

function responseProgressByteLength(asset: BundledExampleAsset, response: Response): number {
  if (response.headers.has("content-encoding")) return asset.byteLength;
  const header = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(header) && header > 0 ? header : asset.byteLength;
}

async function fetchExampleAssetResponse(
  asset: BundledExampleAsset,
  baseUrl: string | URL,
  fetcher: ExampleAssetFetcher,
  signal?: AbortSignal,
): Promise<ExampleAssetResponse> {
  signal?.throwIfAborted();
  const response = await fetcher(resolveExampleAssetUrl(asset, baseUrl), { signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const status = response.statusText
      ? `${response.status} ${response.statusText}`
      : String(response.status);
    throw new Error(`Could not load bundled example file "${asset.fileName}" (HTTP ${status}).`);
  }
  return {
    asset,
    response,
    progressByteLength: responseProgressByteLength(asset, response),
  };
}

async function responseToBytes(
  entry: ExampleAssetResponse,
  signal: AbortSignal | undefined,
  onBytes: (loadedBytes: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  const reader = entry.response.body?.getReader();
  if (!reader) throw new Error(`Bundled example file "${entry.asset.fileName}" has no readable body.`);
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      loadedBytes += result.value.byteLength;
      onBytes(loadedBytes);
    }
  } catch (error: unknown) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const output = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function aggregateProgress(
  entries: readonly ExampleAssetResponse[],
  message: string,
  onProgress?: (message: string, progress: number) => void,
): Array<(loadedBytes: number) => void> {
  const loaded = new Array<number>(entries.length).fill(0);
  const total = entries.reduce((sum, entry) => sum + entry.progressByteLength, 0);
  let lastProgress = 0;
  return entries.map((_entry, index) => (loadedBytes: number): void => {
    loaded[index] = Math.max(loaded[index] ?? 0, loadedBytes);
    const current = loaded.reduce((sum, value, entryIndex) => (
      sum + Math.min(value, entries[entryIndex]?.progressByteLength ?? value)
    ), 0);
    const progress = total > 0 ? Math.min(1, current / total) : 0;
    if (progress <= lastProgress || progress >= 1) return;
    lastProgress = progress;
    onProgress?.(message, progress);
  });
}

/** Loads only the small FAI and precomputed overview needed for first paint. */
export async function loadBundledArabidopsisExample(
  options: LoadArabidopsisExampleOptions = {},
): Promise<ArabidopsisExampleStartup> {
  const {
    signal,
    onProgress,
    baseUrl = defaultApplicationBaseUrl(),
    fetcher = globalThis.fetch,
  } = options;
  signal?.throwIfAborted();
  const message = "Loading precomputed Arabidopsis overview";
  onProgress?.(message, 0);

  const entries = await Promise.all([
    fetchExampleAssetResponse(ARABIDOPSIS_EXAMPLE_ASSETS.fai, baseUrl, fetcher, signal),
    fetchExampleAssetResponse(ARABIDOPSIS_EXAMPLE_ASSETS.overview, baseUrl, fetcher, signal),
  ]);
  signal?.throwIfAborted();
  const reporters = aggregateProgress(entries, message, onProgress);
  const [faiBytes, overviewBytes] = await Promise.all([
    responseToBytes(entries[0]!, signal, reporters[0]!),
    responseToBytes(entries[1]!, signal, reporters[1]!),
  ]);
  signal?.throwIfAborted();

  const [, overviewRepresentation] = await Promise.all([
    verifyAssetDigest(ARABIDOPSIS_EXAMPLE_ASSETS.fai, faiBytes),
    verifyAssetDigest(ARABIDOPSIS_EXAMPLE_ASSETS.overview, overviewBytes),
  ]);
  const artifact = overviewRepresentation === "decoded"
    ? decodePrecomputedOverview(overviewBytes)
    : await decodePrecomputedOverviewGzip(overviewBytes);
  const faiText = new TextDecoder("utf-8", { fatal: true }).decode(faiBytes);
  if (faiText !== artifact.fastaIndexText) {
    throw new Error("Bundled FASTA index does not match the precomputed overview.");
  }
  for (const role of ["fasta", "fai", "annotation"] as const) {
    const declared = artifact.sourceAssets.find((asset) => asset.role === role);
    const expected = ARABIDOPSIS_EXAMPLE_ASSETS[role];
    if (
      !declared
      || declared.fileName !== expected.fileName
      || declared.byteLength !== expected.byteLength
      || declared.sha256 !== expected.sha256
    ) {
      throw new Error(`Precomputed overview identifies an unexpected ${role.toUpperCase()} source.`);
    }
  }
  const fastaAsset = artifact.sourceAssets.find((asset) => asset.role === "fasta")!;
  signal?.throwIfAborted();
  onProgress?.(message, 1);
  return {
    source: {
      url: resolveExampleAssetUrl(ARABIDOPSIS_EXAMPLE_ASSETS.fasta, baseUrl),
      fileName: fastaAsset.fileName,
      byteLength: fastaAsset.byteLength,
    },
    artifact,
  };
}

/** Downloads the optional annotation independently after the workspace is visible. */
export async function loadBundledArabidopsisAnnotation(
  options: LoadArabidopsisAnnotationOptions = {},
): Promise<File> {
  const {
    signal,
    onProgress,
    baseUrl = defaultApplicationBaseUrl(),
    fetcher = globalThis.fetch,
  } = options;
  signal?.throwIfAborted();
  const asset = ARABIDOPSIS_EXAMPLE_ASSETS.annotation;
  const message = "Loading included CEN180 annotations";
  onProgress?.(message, 0);
  const entry = await fetchExampleAssetResponse(asset, baseUrl, fetcher, signal);
  const bytes = await responseToBytes(entry, signal, (loaded) => {
    const progress = entry.progressByteLength > 0
      ? Math.min(1, loaded / entry.progressByteLength)
      : 0;
    if (progress < 1) onProgress?.(message, progress);
  });
  signal?.throwIfAborted();
  await verifyAssetDigest(asset, bytes);
  signal?.throwIfAborted();
  onProgress?.(message, 1);
  return new File([bytes.buffer], asset.fileName, {
    type: asset.mediaType,
    lastModified: 0,
  });
}

async function verifyAssetDigest(
  asset: BundledExampleAsset,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<"encoded" | "decoded"> {
  const representations: Array<{
    kind: "encoded" | "decoded";
    byteLength: number;
    sha256: string | undefined;
  }> = [
    { kind: "encoded" as const, byteLength: asset.byteLength, sha256: asset.sha256 },
  ];
  if (asset.decodedByteLength !== undefined || asset.decodedSha256 !== undefined) {
    if (asset.decodedByteLength === undefined || asset.decodedSha256 === undefined) {
      throw new Error(`Bundled example file "${asset.fileName}" has incomplete decoded provenance.`);
    }
    representations.push({
      kind: "decoded" as const,
      byteLength: asset.decodedByteLength,
      sha256: asset.decodedSha256,
    });
  }
  const matchingLength = representations.filter(({ byteLength }) => byteLength === bytes.byteLength);
  if (matchingLength.length === 0) {
    const expected = representations
      .map(({ byteLength }) => byteLength.toLocaleString("en-US"))
      .join(" or ");
    throw new Error(
      `Bundled example file "${asset.fileName}" has ${bytes.byteLength.toLocaleString("en-US")} bytes; expected ${expected}.`,
    );
  }
  if (matchingLength.some(({ sha256 }) => !sha256)) return matchingLength[0]!.kind;
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot verify the bundled example assets.");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const actual = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const verified = matchingLength.find(({ sha256 }) => sha256 === actual);
  if (!verified) {
    throw new Error(`Bundled example file "${asset.fileName}" failed its SHA-256 check.`);
  }
  return verified.kind;
}
