import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compressedPath = resolve(root, "assets/example-data/Col-CEN_v1.2.fasta.gz");
const outputPath = resolve(root, "web/public/examples/Col-CEN_v1.2.fasta");
const temporaryPath = `${outputPath}.${process.pid}.tmp`;

const EXPECTED_COMPRESSED_BYTES = 36_070_352;
const EXPECTED_COMPRESSED_SHA256 = "8ed838f8a405abf00e8de32bccf4f78a969b58c6ac22c3182f53e3982abc00e7";
const EXPECTED_FASTA_BYTES = 134_282_475;
const EXPECTED_FASTA_SHA256 = "21c467339262bcc1854492451894241ac1bc31de63c5a1521caeb5439075bcd2";

const compressed = await fingerprint(compressedPath);
requireFingerprint("compressed Arabidopsis source", compressed, {
  bytes: EXPECTED_COMPRESSED_BYTES,
  sha256: EXPECTED_COMPRESSED_SHA256,
});

const existing = await fingerprint(outputPath, true);
if (
  existing?.bytes === EXPECTED_FASTA_BYTES
  && existing.sha256 === EXPECTED_FASTA_SHA256
) {
  console.log("Bundled Arabidopsis FASTA is already prepared.");
  process.exit(0);
}

await mkdir(dirname(outputPath), { recursive: true });
await unlink(temporaryPath).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
});

let writtenBytes = 0;
const outputHash = createHash("sha256");
const verifier = new Transform({
  transform(chunk, _encoding, callback) {
    writtenBytes += chunk.byteLength;
    outputHash.update(chunk);
    callback(null, chunk);
  },
});

try {
  await pipeline(
    createReadStream(compressedPath),
    createGunzip(),
    verifier,
    createWriteStream(temporaryPath, { flags: "wx" }),
  );
  const generated = { bytes: writtenBytes, sha256: outputHash.digest("hex") };
  requireFingerprint("decompressed Arabidopsis FASTA", generated, {
    bytes: EXPECTED_FASTA_BYTES,
    sha256: EXPECTED_FASTA_SHA256,
  });
  await rename(temporaryPath, outputPath);
} catch (error) {
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

console.log(`Prepared ${outputPath} (${writtenBytes.toLocaleString("en-US")} bytes).`);

async function fingerprint(path, optional = false) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: metadata.size, sha256: hash.digest("hex") };
}

function requireFingerprint(label, actual, expected) {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(
      `${label} failed integrity validation: received ${actual.bytes} bytes / ${actual.sha256}.`,
    );
  }
}
