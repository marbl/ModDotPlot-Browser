const MAGIC_TEXT = "MDPOVR01";
const MAGIC = new TextEncoder().encode(MAGIC_TEXT);
const PREFIX_BYTES = 16;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_RESOLUTION = 4_096;
const TILE_EDGE = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONFIG_DIGEST_PATTERN = /^[0-9a-f]{16}$/;
const CONFIG_IDENTITY_PATTERN = /^[0-9a-f]{108}$/;

/** Current on-disk schema for bundled, precomputed overview tiles. */
export const PRECOMPUTED_OVERVIEW_SCHEMA_VERSION = 1 as const;

export type PrecomputedSourceRole = "fasta" | "fai" | "annotation";

export interface PrecomputedSourceAsset {
  role: PrecomputedSourceRole;
  fileName: string;
  byteLength: number;
  sha256: string;
}

export interface PrecomputedSequenceMetadata {
  index: number;
  name: string;
  description: string;
  length: number;
  sourceFile: string;
}

/**
 * Browser-facing scientific metadata plus the complete 54-byte canonical identity.
 *
 * The identity is authoritative for compatibility. The shorter digest is checked
 * against it, while the named fields make provenance readable without decoding the
 * Rust configuration schema.
 */
export interface PrecomputedScientificConfig {
  version: number;
  identity: string;
  digest: string;
  hashAlgorithm: string;
  hashSeed: string;
  estimator: string;
  k: number;
  registerCount: number;
  hllPrecision: number;
  bBits: number;
  verificationBits: number;
  identityScale: number;
  missingIdentity: number;
}

export interface PrecomputedComparison {
  xIndex: number;
  yIndex: number;
  resolution: number;
  k: number;
  configDigest: string;
}

export interface PrecomputedOverviewTile {
  quality: "refined";
  configDigest: string;
  resolution: number;
  x: number;
  y: number;
  width: number;
  height: number;
  identity: Uint16Array;
  direction: Int16Array;
  directionSupport: Uint16Array;
}

export interface PrecomputedOverviewArtifact {
  schemaVersion: typeof PRECOMPUTED_OVERVIEW_SCHEMA_VERSION;
  /** Stable generator identifier. Deliberately excludes a wall-clock timestamp. */
  generator: string;
  sourceAssets: PrecomputedSourceAsset[];
  /** Exact checked-in FAI bytes interpreted as UTF-8 text. */
  fastaIndexText: string;
  sequences: PrecomputedSequenceMetadata[];
  comparison: PrecomputedComparison;
  configurations: PrecomputedScientificConfig[];
  tiles: PrecomputedOverviewTile[];
}

interface TileDescriptor {
  quality: "refined";
  configDigest: string;
  resolution: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ArtifactHeader {
  schemaVersion: number;
  generator: string;
  sourceAssets: PrecomputedSourceAsset[];
  fastaIndexText: string;
  sequences: PrecomputedSequenceMetadata[];
  comparison: PrecomputedComparison;
  configurations: PrecomputedScientificConfig[];
  tiles: TileDescriptor[];
}

interface FaiEntry {
  name: string;
  length: number;
}

/** Encodes one fully covered refined overview into the deterministic v1 binary form. */
export function encodePrecomputedOverview(artifact: PrecomputedOverviewArtifact): Uint8Array {
  validateArtifact(artifact);
  const header: ArtifactHeader = {
    schemaVersion: artifact.schemaVersion,
    generator: artifact.generator,
    sourceAssets: artifact.sourceAssets,
    fastaIndexText: artifact.fastaIndexText,
    sequences: artifact.sequences,
    comparison: artifact.comparison,
    configurations: artifact.configurations,
    tiles: artifact.tiles.map(({ identity: _identity, direction: _direction, directionSupport: _support, ...tile }) => tile),
  };
  const headerBytes = new TextEncoder().encode(canonicalJson(header));
  if (headerBytes.byteLength > MAX_HEADER_BYTES) {
    throw new Error("Precomputed overview header exceeds the supported size");
  }
  const padding = headerBytes.byteLength % 2;
  const payloadBytes = artifact.tiles.reduce(
    (total, tile) => total + tile.identity.byteLength + tile.direction.byteLength + tile.directionSupport.byteLength,
    0,
  );
  const output = new Uint8Array(PREFIX_BYTES + headerBytes.byteLength + padding + payloadBytes);
  output.set(MAGIC, 0);
  const prefix = new DataView(output.buffer, output.byteOffset, PREFIX_BYTES);
  prefix.setUint32(8, PRECOMPUTED_OVERVIEW_SCHEMA_VERSION, true);
  prefix.setUint32(12, headerBytes.byteLength, true);
  output.set(headerBytes, PREFIX_BYTES);

  let offset = PREFIX_BYTES + headerBytes.byteLength + padding;
  for (const tile of artifact.tiles) {
    offset = writeUint16(output, offset, tile.identity);
    offset = writeInt16(output, offset, tile.direction);
    offset = writeUint16(output, offset, tile.directionSupport);
  }
  return output;
}

/** Decodes and defensively validates an uncompressed v1 overview artifact. */
export function decodePrecomputedOverview(bytes: Uint8Array): PrecomputedOverviewArtifact {
  if (bytes.byteLength < PREFIX_BYTES) throw new Error("Precomputed overview is truncated before its header");
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (bytes[index] !== MAGIC[index]) throw new Error("Precomputed overview has an invalid magic signature");
  }
  const prefix = new DataView(bytes.buffer, bytes.byteOffset, PREFIX_BYTES);
  const schemaVersion = prefix.getUint32(8, true);
  if (schemaVersion !== PRECOMPUTED_OVERVIEW_SCHEMA_VERSION) {
    throw new Error(`Unsupported precomputed overview schema version ${schemaVersion}`);
  }
  const headerLength = prefix.getUint32(12, true);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw new Error("Precomputed overview declares an invalid header length");
  }
  const padding = headerLength % 2;
  const payloadStart = PREFIX_BYTES + headerLength + padding;
  if (payloadStart > bytes.byteLength) throw new Error("Precomputed overview is truncated inside its header");

  let parsed: unknown;
  try {
    const headerText = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength));
    parsed = JSON.parse(headerText) as unknown;
  } catch (error) {
    throw new Error("Precomputed overview header is not valid UTF-8 JSON", { cause: error });
  }
  const header = parseHeader(parsed);
  if (header.schemaVersion !== schemaVersion) {
    throw new Error("Precomputed overview prefix and header schema versions disagree");
  }

  let offset = payloadStart;
  const tiles: PrecomputedOverviewTile[] = [];
  for (const descriptor of header.tiles) {
    const cells = checkedCellCount(descriptor.width, descriptor.height);
    const channelBytes = cells * 2;
    if (offset + channelBytes * 3 > bytes.byteLength) {
      throw new Error("Precomputed overview is truncated inside a tile payload");
    }
    const identity = readUint16(bytes, offset, cells);
    offset += channelBytes;
    const direction = readInt16(bytes, offset, cells);
    offset += channelBytes;
    const directionSupport = readUint16(bytes, offset, cells);
    offset += channelBytes;
    tiles.push({ ...descriptor, identity, direction, directionSupport });
  }
  if (offset !== bytes.byteLength) throw new Error("Precomputed overview contains trailing payload bytes");

  const artifact: PrecomputedOverviewArtifact = {
    schemaVersion: PRECOMPUTED_OVERVIEW_SCHEMA_VERSION,
    generator: header.generator,
    sourceAssets: header.sourceAssets,
    fastaIndexText: header.fastaIndexText,
    sequences: header.sequences,
    comparison: header.comparison,
    configurations: header.configurations,
    tiles,
  };
  validateArtifact(artifact);
  return artifact;
}

/** Decompresses a gzip-wrapped artifact and then applies the complete v1 validation. */
export async function decodePrecomputedOverviewGzip(bytes: Uint8Array): Promise<PrecomputedOverviewArtifact> {
  if (!("DecompressionStream" in globalThis)) {
    throw new Error("This browser cannot decompress the bundled precomputed overview");
  }
  let decompressed: ArrayBuffer;
  try {
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    const input = new Blob([owned.buffer]).stream();
    const stream = input.pipeThrough(new DecompressionStream("gzip"));
    decompressed = await new Response(stream).arrayBuffer();
  } catch (error) {
    throw new Error("Bundled precomputed overview gzip data is invalid", { cause: error });
  }
  return decodePrecomputedOverview(new Uint8Array(decompressed));
}

function validateArtifact(artifact: PrecomputedOverviewArtifact): void {
  if (artifact.schemaVersion !== PRECOMPUTED_OVERVIEW_SCHEMA_VERSION) {
    throw new Error(`Unsupported precomputed overview schema version ${String(artifact.schemaVersion)}`);
  }
  if (!artifact.generator.trim()) throw new Error("Precomputed overview generator identifier is empty");
  validateSourceAssets(artifact.sourceAssets, artifact.fastaIndexText);
  validateSequences(artifact.sequences, artifact.fastaIndexText, artifact.sourceAssets);
  validateConfigurations(artifact.configurations);
  validateComparison(artifact.comparison, artifact.sequences, artifact.configurations);
  validateTiles(artifact.tiles, artifact.comparison);
}

function validateSourceAssets(assets: PrecomputedSourceAsset[], fastaIndexText: string): void {
  if (!Array.isArray(assets) || assets.length < 2) {
    throw new Error("Precomputed overview must identify its FASTA and FAI source assets");
  }
  const roles = new Set<PrecomputedSourceRole>();
  for (const asset of assets) {
    if (!(["fasta", "fai", "annotation"] as const).includes(asset.role)) {
      throw new Error("Precomputed overview contains an unknown source-asset role");
    }
    if (roles.has(asset.role)) throw new Error(`Precomputed overview repeats source role '${asset.role}'`);
    roles.add(asset.role);
    if (!asset.fileName.trim() || asset.fileName.includes("/") || asset.fileName.includes("\\")) {
      throw new Error("Precomputed overview source filenames must be plain non-empty names");
    }
    if (!Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0) {
      throw new Error(`Precomputed overview source '${asset.fileName}' has an invalid byte length`);
    }
    if (!SHA256_PATTERN.test(asset.sha256)) {
      throw new Error(`Precomputed overview source '${asset.fileName}' has an invalid SHA-256`);
    }
  }
  if (!roles.has("fasta") || !roles.has("fai")) {
    throw new Error("Precomputed overview must identify exactly one FASTA and one FAI source");
  }
  const fai = assets.find((asset) => asset.role === "fai");
  if (!fai || new TextEncoder().encode(fastaIndexText).byteLength !== fai.byteLength) {
    throw new Error("Precomputed overview FAI text does not match the declared source byte length");
  }
}

function validateSequences(
  sequences: PrecomputedSequenceMetadata[],
  fastaIndexText: string,
  assets: PrecomputedSourceAsset[],
): void {
  if (!Array.isArray(sequences) || sequences.length === 0) {
    throw new Error("Precomputed overview contains no sequence metadata");
  }
  const fasta = assets.find((asset) => asset.role === "fasta");
  const fai = parseFai(fastaIndexText);
  if (fai.length !== sequences.length) {
    throw new Error("Precomputed overview sequence metadata does not cover every FAI record");
  }
  const names = new Set<string>();
  for (let index = 0; index < sequences.length; index += 1) {
    const sequence = sequences[index];
    const indexed = fai[index];
    if (!sequence || !indexed) throw new Error("Precomputed overview sequence metadata is incomplete");
    if (sequence.index !== index) throw new Error("Precomputed overview sequence indexes must be contiguous and ordered");
    if (!sequence.name || names.has(sequence.name)) throw new Error("Precomputed overview sequence names must be unique");
    names.add(sequence.name);
    if (!Number.isSafeInteger(sequence.length) || sequence.length <= 0) {
      throw new Error(`Precomputed overview sequence '${sequence.name}' has an invalid length`);
    }
    if (sequence.name !== indexed.name || sequence.length !== indexed.length) {
      throw new Error("Precomputed overview sequence metadata disagrees with its FAI text");
    }
    if (!fasta || sequence.sourceFile !== fasta.fileName) {
      throw new Error("Precomputed overview sequence metadata names the wrong FASTA source");
    }
  }
}

function parseFai(text: string): FaiEntry[] {
  const entries: FaiEntry[] = [];
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 5) throw new Error("Precomputed overview contains malformed FAI text");
    const [name = "", lengthText = "", offsetText = "", lineBasesText = "", lineWidthText = ""] = fields;
    const values = [lengthText, offsetText, lineBasesText, lineWidthText].map(Number);
    const [length, offset, lineBases, lineWidth] = values;
    if (
      !name || names.has(name)
      || values.some((value) => !Number.isSafeInteger(value) || value < 0)
      || !length || !lineBases || !lineWidth || lineWidth < lineBases || offset === undefined
    ) {
      throw new Error("Precomputed overview contains invalid FAI record metadata");
    }
    names.add(name);
    entries.push({ name, length });
  }
  if (entries.length === 0) throw new Error("Precomputed overview contains an empty FAI index");
  return entries;
}

function validateConfigurations(configurations: PrecomputedScientificConfig[]): void {
  if (!Array.isArray(configurations) || configurations.length === 0) {
    throw new Error("Precomputed overview contains no scientific configuration");
  }
  const digests = new Set<string>();
  let previousRegisters = 0;
  for (const config of configurations) {
    if (!CONFIG_DIGEST_PATTERN.test(config.digest) || digests.has(config.digest)) {
      throw new Error("Precomputed overview has an invalid or repeated scientific digest");
    }
    digests.add(config.digest);
    if (!CONFIG_IDENTITY_PATTERN.test(config.identity)) {
      throw new Error("Precomputed overview has an invalid canonical scientific identity");
    }
    if (digestIdentity(config.identity) !== config.digest) {
      throw new Error("Precomputed overview scientific digest does not match its canonical identity");
    }
    validateConfigurationIdentityFields(config);
    if (!Number.isSafeInteger(config.registerCount) || config.registerCount <= previousRegisters) {
      throw new Error("Precomputed overview configurations must have increasing register counts");
    }
    previousRegisters = config.registerCount;
  }
}

function validateConfigurationIdentityFields(config: PrecomputedScientificConfig): void {
  const bytes = hexBytes(config.identity);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expectedHash = config.hashAlgorithm === "nthash2" ? 1 : -1;
  const expectedEstimator = config.estimator === "verified_winners" ? 2 : -1;
  const seed = parseDecimalBigInt(config.hashSeed, "hash seed");
  if (
    view.getUint16(0, true) !== config.version
    || bytes[2] !== config.k
    || bytes[3] !== expectedHash
    || view.getBigUint64(4, true) !== seed
    || view.getBigUint64(12, true) !== BigInt(config.registerCount)
    || bytes[20] !== config.bBits
    || bytes[21] !== config.verificationBits
    || bytes[22] !== expectedEstimator
    || bytes[23] !== config.hllPrecision
    || view.getUint16(50, true) !== config.missingIdentity
    || view.getUint16(52, true) !== config.identityScale
  ) {
    throw new Error("Precomputed overview scientific metadata disagrees with its canonical identity");
  }
}

function validateComparison(
  comparison: PrecomputedComparison,
  sequences: PrecomputedSequenceMetadata[],
  configurations: PrecomputedScientificConfig[],
): void {
  if (!Number.isSafeInteger(comparison.resolution) || comparison.resolution <= 0 || comparison.resolution > MAX_RESOLUTION) {
    throw new Error("Precomputed overview comparison has an unsupported resolution");
  }
  if (!Number.isSafeInteger(comparison.xIndex) || !sequences[comparison.xIndex]) {
    throw new Error("Precomputed overview comparison has an invalid X sequence index");
  }
  if (!Number.isSafeInteger(comparison.yIndex) || !sequences[comparison.yIndex]) {
    throw new Error("Precomputed overview comparison has an invalid Y sequence index");
  }
  if (!Number.isSafeInteger(comparison.k) || comparison.k < 1 || comparison.k > 31) {
    throw new Error("Precomputed overview comparison has an invalid k-mer length");
  }
  const config = configurations.find(({ digest }) => digest === comparison.configDigest);
  if (!config || config.k !== comparison.k) {
    throw new Error("Precomputed overview comparison names an incompatible scientific configuration");
  }
}

function validateTiles(tiles: PrecomputedOverviewTile[], comparison: PrecomputedComparison): void {
  if (!Array.isArray(tiles) || tiles.length === 0) throw new Error("Precomputed overview contains no tiles");
  const coverage = new Uint8Array(comparison.resolution * comparison.resolution);
  let previousKey = -1;
  for (const tile of tiles) {
    if (
      tile.quality !== "refined"
      || tile.configDigest !== comparison.configDigest
      || tile.resolution !== comparison.resolution
    ) {
      throw new Error("Precomputed overview tile provenance does not match its comparison");
    }
    if (
      !Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y)
      || !Number.isSafeInteger(tile.width) || !Number.isSafeInteger(tile.height)
      || tile.x < 0 || tile.y < 0 || tile.width <= 0 || tile.height <= 0
      || tile.width > TILE_EDGE || tile.height > TILE_EDGE
      || tile.x % TILE_EDGE !== 0 || tile.y % TILE_EDGE !== 0
      || tile.x + tile.width > comparison.resolution
      || tile.y + tile.height > comparison.resolution
    ) {
      throw new Error("Precomputed overview tile lies outside its declared resolution");
    }
    const key = tile.y * comparison.resolution + tile.x;
    if (key <= previousKey) throw new Error("Precomputed overview tiles must use canonical row-major order");
    previousKey = key;
    const cells = checkedCellCount(tile.width, tile.height);
    if (
      !(tile.identity instanceof Uint16Array) || tile.identity.length !== cells
      || !(tile.direction instanceof Int16Array) || tile.direction.length !== cells
      || !(tile.directionSupport instanceof Uint16Array) || tile.directionSupport.length !== cells
    ) {
      throw new Error("Precomputed overview tile channels do not match its dimensions");
    }
    for (let row = 0; row < tile.height; row += 1) {
      const start = (tile.y + row) * comparison.resolution + tile.x;
      for (let column = 0; column < tile.width; column += 1) {
        const cell = start + column;
        if (coverage[cell]) throw new Error("Precomputed overview tiles overlap");
        coverage[cell] = 1;
      }
    }
  }
  if (coverage.includes(0)) throw new Error("Precomputed overview tiles do not fully cover the matrix");
}

function parseHeader(value: unknown): ArtifactHeader {
  if (!isRecord(value)) throw new Error("Precomputed overview JSON header must be an object");
  const {
    schemaVersion, generator, sourceAssets, fastaIndexText,
    sequences, comparison, configurations, tiles,
  } = value;
  if (
    typeof schemaVersion !== "number" || typeof generator !== "string"
    || !Array.isArray(sourceAssets) || typeof fastaIndexText !== "string"
    || !Array.isArray(sequences) || !isRecord(comparison)
    || !Array.isArray(configurations) || !Array.isArray(tiles)
  ) {
    throw new Error("Precomputed overview JSON header has an invalid shape");
  }
  return {
    schemaVersion,
    generator,
    sourceAssets: sourceAssets.map(parseSourceAsset),
    fastaIndexText,
    sequences: sequences.map(parseSequence),
    comparison: parseComparison(comparison),
    configurations: configurations.map(parseConfiguration),
    tiles: tiles.map(parseTileDescriptor),
  };
}

function parseSourceAsset(value: unknown): PrecomputedSourceAsset {
  if (!isRecord(value)) throw new Error("Precomputed overview source entry is invalid");
  return {
    role: requireString(value.role, "source role") as PrecomputedSourceRole,
    fileName: requireString(value.fileName, "source filename"),
    byteLength: requireNumber(value.byteLength, "source byte length"),
    sha256: requireString(value.sha256, "source SHA-256"),
  };
}

function parseSequence(value: unknown): PrecomputedSequenceMetadata {
  if (!isRecord(value)) throw new Error("Precomputed overview sequence entry is invalid");
  return {
    index: requireNumber(value.index, "sequence index"),
    name: requireString(value.name, "sequence name"),
    description: requireString(value.description, "sequence description"),
    length: requireNumber(value.length, "sequence length"),
    sourceFile: requireString(value.sourceFile, "sequence source"),
  };
}

function parseComparison(value: Record<string, unknown>): PrecomputedComparison {
  return {
    xIndex: requireNumber(value.xIndex, "comparison X index"),
    yIndex: requireNumber(value.yIndex, "comparison Y index"),
    resolution: requireNumber(value.resolution, "comparison resolution"),
    k: requireNumber(value.k, "comparison k"),
    configDigest: requireString(value.configDigest, "comparison configuration digest"),
  };
}

function parseConfiguration(value: unknown): PrecomputedScientificConfig {
  if (!isRecord(value)) throw new Error("Precomputed overview scientific configuration is invalid");
  return {
    version: requireNumber(value.version, "configuration version"),
    identity: requireString(value.identity, "configuration identity"),
    digest: requireString(value.digest, "configuration digest"),
    hashAlgorithm: requireString(value.hashAlgorithm, "configuration hash algorithm"),
    hashSeed: requireString(value.hashSeed, "configuration hash seed"),
    estimator: requireString(value.estimator, "configuration estimator"),
    k: requireNumber(value.k, "configuration k"),
    registerCount: requireNumber(value.registerCount, "configuration register count"),
    hllPrecision: requireNumber(value.hllPrecision, "configuration HLL precision"),
    bBits: requireNumber(value.bBits, "configuration comparison bits"),
    verificationBits: requireNumber(value.verificationBits, "configuration verification bits"),
    identityScale: requireNumber(value.identityScale, "configuration identity scale"),
    missingIdentity: requireNumber(value.missingIdentity, "configuration missing identity"),
  };
}

function parseTileDescriptor(value: unknown): TileDescriptor {
  if (!isRecord(value)) throw new Error("Precomputed overview tile descriptor is invalid");
  const quality = requireString(value.quality, "tile quality");
  if (quality !== "refined") throw new Error("Precomputed overview supports only refined tiles");
  return {
    quality,
    configDigest: requireString(value.configDigest, "tile configuration digest"),
    resolution: requireNumber(value.resolution, "tile resolution"),
    x: requireNumber(value.x, "tile X origin"),
    y: requireNumber(value.y, "tile Y origin"),
    width: requireNumber(value.width, "tile width"),
    height: requireNumber(value.height, "tile height"),
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Precomputed overview ${label} must be a string`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Precomputed overview ${label} must be a finite number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedCellCount(width: number, height: number): number {
  const cells = width * height;
  if (!Number.isSafeInteger(cells) || cells <= 0) throw new Error("Precomputed overview tile dimensions overflow");
  return cells;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Precomputed overview header contains an unsupported value");
  return encoded;
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function digestIdentity(identity: string): string {
  let digest = 0xcbf2_9ce4_8422_2325n;
  const prime = 0x0000_0100_0000_01b3n;
  for (const byte of hexBytes(identity)) {
    digest ^= BigInt(byte);
    digest = BigInt.asUintN(64, digest * prime);
  }
  return digest.toString(16).padStart(16, "0");
}

function parseDecimalBigInt(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`Precomputed overview configuration ${label} is not an unsigned decimal integer`);
  }
  return BigInt(value);
}

function writeUint16(output: Uint8Array, offset: number, values: Uint16Array): number {
  const view = new DataView(output.buffer, output.byteOffset + offset, values.byteLength);
  for (let index = 0; index < values.length; index += 1) view.setUint16(index * 2, values[index] ?? 0, true);
  return offset + values.byteLength;
}

function writeInt16(output: Uint8Array, offset: number, values: Int16Array): number {
  const view = new DataView(output.buffer, output.byteOffset + offset, values.byteLength);
  for (let index = 0; index < values.length; index += 1) view.setInt16(index * 2, values[index] ?? 0, true);
  return offset + values.byteLength;
}

function readUint16(bytes: Uint8Array, offset: number, length: number): Uint16Array {
  const result = new Uint16Array(length);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length * 2);
  for (let index = 0; index < length; index += 1) result[index] = view.getUint16(index * 2, true);
  return result;
}

function readInt16(bytes: Uint8Array, offset: number, length: number): Int16Array {
  const result = new Int16Array(length);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length * 2);
  for (let index = 0; index < length; index += 1) result[index] = view.getInt16(index * 2, true);
  return result;
}
