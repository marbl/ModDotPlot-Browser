import { readFileSync } from "node:fs";
import { join } from "node:path";

function read(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function byteBudget(source, name) {
  const expression = source.match(new RegExp(`const ${name}: usize = ([^;]+);`))?.[1];
  if (!expression) throw new Error(`missing byte budget ${name}`);
  return expression
    .split("*")
    .map((item) => Number(item.trim().replaceAll("_", "")))
    .reduce((product, factor) => product * factor, 1);
}

function englishList(items) {
  if (items.length < 2) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function estimatorHeader(source) {
  const start = source.indexOf('"estimator\\tregisters\\thll');
  if (start < 0) throw new Error("missing estimator validation header literal");
  const end = source.indexOf('"', start + 1);
  if (end < 0) throw new Error("unterminated estimator validation header literal");
  return JSON.parse(source.slice(start, end + 1)).split("\t");
}

export function currentDocumentationContract(root) {
  const wasm = read(root, "crates/wasm/src/lib.rs");
  const html = read(root, "web/index.html");
  const main = read(root, "web/src/main.ts");
  const importedTrackTypes = read(root, "web/src/imported-track-types.ts");
  const estimatorValidation = read(root, "crates/core/tests/estimator_validation.rs");
  const releaseValidation = read(root, "docs/releases/v0.2.0-beta.1/estimator-validation.tsv");

  const formatDeclaration = importedTrackTypes.match(
    /export type ImportedTrackFormat = ([^;]+);/,
  )?.[1];
  if (!formatDeclaration) throw new Error("missing ImportedTrackFormat declaration");
  const formats = [...formatDeclaration.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const formatLabels = new Map([
    ["bed", "BED3–12"],
    ["gff3", "GFF3"],
    ["gtf", "GTF"],
  ]);
  const labels = formats.map((format) => {
    const label = formatLabels.get(format);
    if (!label) throw new Error(`missing documentation label for imported format ${format}`);
    return label;
  });

  const accept = html.match(/<input id="track-file-input"[^>]*accept="([^"]+)"/)?.[1]
    ?.split(",")
    .map((extension) => extension.trim());
  if (!accept) throw new Error("missing track-file-input accept contract");
  const accepted = new Set(accept);
  const baseExtensions = new Map([
    ["bed", [".bed"]],
    ["gff3", [".gff", ".gff3"]],
    ["gtf", [".gtf", ".gff2"]],
  ]);
  for (const format of formats) {
    const bases = baseExtensions.get(format);
    if (!bases) throw new Error(`missing accepted-extension mapping for ${format}`);
    if (!bases.some((extension) => accepted.has(extension))) {
      throw new Error(`${format} lacks a plain-text accepted extension`);
    }
    if (!bases.some((extension) => accepted.has(`${extension}.gz`))) {
      throw new Error(`${format} lacks a gzip accepted extension`);
    }
    if (!bases.some((extension) => accepted.has(`${extension}.bgz`)) && !accepted.has(".bgzf")) {
      throw new Error(`${format} lacks a BGZF accepted extension`);
    }
  }

  const sparseAssignments = [...main.matchAll(/sparseCorrection:\s*(true|false)/g)].map(
    (match) => match[1],
  );
  const sparseControlExposed = /id="[^"]*(?:high-sensitivity|sparse-correction)/i.test(html);
  if (sparseAssignments.length !== 1 || sparseAssignments[0] !== "false" || sparseControlExposed) {
    throw new Error("browser sparse-correction exposure changed; update the documentation contract");
  }

  const validationColumns = estimatorHeader(estimatorValidation);
  const releaseValidationColumns = releaseValidation.split(/\r?\n/, 1)[0].split("\t");
  if (validationColumns.join("\t") !== releaseValidationColumns.join("\t")) {
    throw new Error("estimator validation source header differs from the release TSV schema");
  }

  return {
    budgets: {
      zoomAxisBytes: byteBudget(wasm, "MAX_CACHED_AXIS_BYTES"),
      preparedAxisBytes: byteBudget(wasm, "MAX_PREPARED_AXIS_BYTES"),
      wasmSessionBytes: byteBudget(wasm, "MAX_WASM_SESSION_BYTES"),
    },
    importedAnnotationSummary: `${englishList(labels)}; plain text, gzip, and BGZF`,
    browserSparseCorrectionSummary:
      "Disabled; no browser control (`sparseCorrection: false`)",
    validationColumns,
  };
}

export function formatMib(bytes) {
  return `${bytes / 1024 / 1024} MiB`;
}
