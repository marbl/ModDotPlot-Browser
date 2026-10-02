#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { encodePrecomputedOverview } from "../web/src/precomputed-overview.ts";
import { transposeTile } from "../web/src/tile.ts";
import { initSync, ComputeSession, ScientificConfig } from "../web/src/wasm/moddotplot_wasm.js";

const SCRIPT_VERSION = 2;
const RESOLUTIONS = [1_000, 2_000, 4_000];
const K = 21;
const REGISTER_COUNT = 1_024;
const TILE_EDGE = 256;
const FASTA_CHUNK_BYTES = 8 * 1024 * 1024;
const PREPARATION_CHUNK_BINS = 64;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const examplesDirectory = resolve(repositoryRoot, "web/public/examples");
const wasmDirectory = resolve(repositoryRoot, "web/src/wasm");
const paths = {
  fasta: resolve(examplesDirectory, "Col-CEN_v1.2.fasta"),
  fai: resolve(examplesDirectory, "Col-CEN_v1.2.fasta.fai"),
  annotation: resolve(examplesDirectory, "ColCEN_CEN180.gff3"),
  wasm: resolve(wasmDirectory, "moddotplot_wasm_bg.wasm"),
};

function outputPath(resolution) {
  return resolve(
    examplesDirectory,
    resolution === 1_000
      ? "Col-CEN_v1.2.Chr1.mdp-overview-v1.gz"
      : `Col-CEN_v1.2.Chr1.${resolution}.mdp-overview-v1.gz`,
  );
}

const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
}
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (nodeMajor < 25) {
  throw new Error("Generating the precomputed overview requires Node.js 25 or newer for native TypeScript imports");
}

const wasmBytes = readFileSync(paths.wasm);
initSync({ module: wasmBytes });
const fastaBytes = readFileSync(paths.fasta);
const faiBytes = readFileSync(paths.fai);
const annotationBytes = readFileSync(paths.annotation);
const faiText = faiBytes.toString("utf8");
const faiRecords = parseFai(faiText);
const session = new ComputeSession();
const config = new ScientificConfig(K, REGISTER_COUNT);

try {
  const parsedRecords = ingestFasta(session, fastaBytes);
  assertRecordsMatchFai(parsedRecords, faiRecords);
  const first = parsedRecords[0];
  if (!first || first.name !== "Chr1") {
    throw new Error("The bundled overview contract requires Chr1 to be FASTA record zero");
  }

  const configMetadata = scientificMetadata(config);
  for (const resolution of RESOLUTIONS) {
    session.begin_prepare_scientific(0, 0, resolution, config, false);
    let progress = 0;
    while (progress < 1) progress = session.prepare_comparison_chunk(PREPARATION_CHUNK_BINS);

    const tileMap = computeWorkerEquivalentSelfTiles(session, config, resolution);
    const artifact = {
      schemaVersion: 1,
      generator: `moddotplot-interactive/generate-arabidopsis-overview@${SCRIPT_VERSION}`,
      sourceAssets: [
        sourceAsset("fasta", paths.fasta, fastaBytes),
        sourceAsset("fai", paths.fai, faiBytes),
        sourceAsset("annotation", paths.annotation, annotationBytes),
      ],
      fastaIndexText: faiText,
      sequences: faiRecords.map((record, index) => ({
        index,
        name: record.name,
        description: "",
        length: record.length,
        sourceFile: basename(paths.fasta),
      })),
      comparison: {
        xIndex: 0,
        yIndex: 0,
        resolution,
        k: K,
        configDigest: configMetadata.digest,
      },
      configurations: [configMetadata],
      tiles: [...tileMap.values()].sort((left, right) => left.y - right.y || left.x - right.x),
    };
    const encoded = encodePrecomputedOverview(artifact);
    const compressed = deterministicGzip(encoded);
    const output = outputPath(resolution);

    if (checkOnly) {
      if (!existsSync(output)) throw new Error(`Missing generated artifact: ${output}`);
      const checkedIn = readFileSync(output);
      if (!checkedIn.equals(compressed)) {
        throw new Error(
          `Generated overview is stale: run '${process.execPath} scripts/generate-arabidopsis-overview.mjs'`,
        );
      }
      console.log(`Precomputed ${resolution.toLocaleString()} overview is reproducible (${compressed.byteLength.toLocaleString()} bytes)`);
    } else {
      writeFileSync(output, compressed);
      console.log(`Wrote ${output}`);
      console.log(`  resolution: ${resolution.toLocaleString()}`);
      console.log(`  raw:  ${encoded.byteLength.toLocaleString()} bytes`);
      console.log(`  gzip: ${compressed.byteLength.toLocaleString()} bytes`);
      console.log(`  sha256: ${sha256(compressed)}`);
      console.log(`  decoded-sha256: ${sha256(encoded)}`);
      console.log(`  config: ${configMetadata.digest} (${configMetadata.identity})`);
    }
  }
} finally {
  config.free();
  session.free();
}

function ingestFasta(target, fasta) {
  target.begin_fasta();
  const records = [];
  for (let offset = 0; offset < fasta.byteLength; offset += FASTA_CHUNK_BYTES) {
    const end = Math.min(fasta.byteLength, offset + FASTA_CHUNK_BYTES);
    appendRecords(records, target.push_fasta_chunk(fasta.subarray(offset, end)));
  }
  appendRecords(records, target.finish_fasta());
  return records;
}

function appendRecords(output, value) {
  if (!Array.isArray(value)) throw new Error("Wasm FASTA parsing returned invalid record metadata");
  for (const record of value) {
    if (
      typeof record !== "object" || record === null
      || typeof record.name !== "string"
      || !(typeof record.length === "number" || typeof record.length === "bigint")
    ) {
      throw new Error("Wasm FASTA parsing returned a malformed record");
    }
    output.push({ name: record.name, length: Number(record.length) });
  }
}

function parseFai(text) {
  return text.split(/\r?\n/u).filter(Boolean).map((line) => {
    const fields = line.split("\t");
    if (fields.length < 5) throw new Error(`Malformed FAI line: ${line}`);
    const name = fields[0];
    const length = Number(fields[1]);
    if (!name || !Number.isSafeInteger(length) || length <= 0) {
      throw new Error(`Invalid FAI record: ${line}`);
    }
    return { name, length };
  });
}

function assertRecordsMatchFai(records, fai) {
  if (records.length !== fai.length) {
    throw new Error(`FASTA produced ${records.length} records but its FAI declares ${fai.length}`);
  }
  for (let index = 0; index < fai.length; index += 1) {
    const parsed = records[index];
    const indexed = fai[index];
    if (!parsed || !indexed || parsed.name !== indexed.name || parsed.length !== indexed.length) {
      throw new Error(`FASTA record ${index} does not match its FAI metadata`);
    }
  }
}

function computeWorkerEquivalentSelfTiles(target, scientificConfig, resolution) {
  const tiles = new Map();
  for (let y = 0; y < resolution; y += TILE_EDGE) {
    for (let x = y; x < resolution; x += TILE_EDGE) {
      const wasmTile = target.compute_tile_scientific(x, y, TILE_EDGE, TILE_EDGE, scientificConfig);
      const tile = {
        quality: "refined",
        configDigest: scientificConfig.digest,
        resolution,
        x,
        y,
        width: wasmTile.width,
        height: wasmTile.height,
        identity: wasmTile.take_identity(),
        direction: wasmTile.take_direction(),
        directionSupport: wasmTile.take_direction_support(),
      };
      wasmTile.free();
      tiles.set(tileKey(x, y), tile);
      if (x !== y) {
        const mirror = transposeTile(
          tile.identity,
          tile.direction,
          tile.directionSupport,
          tile.width,
          tile.height,
        );
        tiles.set(tileKey(y, x), {
          ...tile,
          x: y,
          y: x,
          width: mirror.width,
          height: mirror.height,
          identity: mirror.identity,
          direction: mirror.direction,
          directionSupport: mirror.directionSupport,
        });
      }
    }
  }
  const tilesPerAxis = Math.ceil(resolution / TILE_EDGE);
  if (tiles.size !== tilesPerAxis * tilesPerAxis) {
    throw new Error(`Expected ${tilesPerAxis * tilesPerAxis} full-matrix tiles, generated ${tiles.size}`);
  }
  return tiles;
}

function tileKey(x, y) {
  return `${x}:${y}`;
}

function scientificMetadata(scientificConfig) {
  const identity = scientificConfig.identity;
  if (typeof identity !== "string" || !/^[0-9a-f]{108}$/u.test(identity)) {
    throw new Error("The generated Wasm bindings do not expose the canonical ScientificConfig.identity");
  }
  return {
    version: scientificConfig.version,
    identity,
    digest: scientificConfig.digest,
    hashAlgorithm: scientificConfig.hash_algorithm,
    hashSeed: scientificConfig.hash_seed,
    estimator: scientificConfig.estimator,
    k: scientificConfig.k,
    registerCount: scientificConfig.register_count,
    hllPrecision: scientificConfig.hll_precision,
    bBits: scientificConfig.b_bits,
    verificationBits: scientificConfig.verification_bits,
    identityScale: scientificConfig.identity_scale,
    missingIdentity: scientificConfig.missing_identity,
  };
}

function sourceAsset(role, path, bytes) {
  return {
    role,
    fileName: basename(path),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deterministicGzip(bytes) {
  const compressed = gzipSync(bytes, { level: 9, mtime: 0 });
  // RFC 1952 byte 9 is an informational originating-OS marker. Neutralizing it
  // makes output identical across Unix, macOS, and Windows Node distributions.
  compressed[9] = 255;
  return compressed;
}
