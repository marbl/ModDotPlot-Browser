export interface FeatureBlock {
  start: number;
  end: number;
  kind: "block" | "thick";
}

export interface TrackFeature {
  start: number;
  end: number;
  name: string;
  type: string;
  strand: "+" | "-" | ".";
  group: string;
  blocks: FeatureBlock[];
}

export interface FeatureTrack {
  fileName: string;
  sequenceName: string;
  format: "BED" | "GFF";
  features: TrackFeature[];
}

/** Parses BED3–12, GFF3, or GTF and verifies it contains the selected FASTA record. */
export function parseFeatureTrack(
  text: string,
  fileName: string,
  fastaName: string,
  sequenceLength: number,
): FeatureTrack {
  const aliases = new Set([fastaName, fastaName.trim().split(/\s+/)[0] ?? fastaName]);
  const lines = text.split(/\r?\n/);
  const data = lines
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith("#") && !line.startsWith("track") && !line.startsWith("browser"));
  if (data.length === 0) throw new Error(`${fileName} contains no BED or GFF features.`);

  const lowerName = fileName.toLowerCase();
  const firstFields = data[0]?.line.split("\t") ?? [];
  const format: "BED" | "GFF" = lowerName.endsWith(".gff") || lowerName.endsWith(".gff3") || lowerName.endsWith(".gtf") || firstFields.length === 9
    ? "GFF"
    : "BED";
  const observedNames = new Set<string>();
  const features: TrackFeature[] = [];
  for (const item of data) {
    const fields = item.line.split("\t");
    const sequenceName = fields[0];
    if (!sequenceName) throw new Error(`${fileName}:${item.number} has no sequence name.`);
    observedNames.add(sequenceName);
    if (!aliases.has(sequenceName)) continue;
    const feature = format === "BED"
      ? parseBed(fields, fileName, item.number)
      : parseGff(fields, fileName, item.number);
    if (feature.start < 0 || feature.end <= feature.start) {
      throw new Error(`${fileName}:${item.number} has an invalid interval.`);
    }
    if (feature.end > sequenceLength) {
      throw new Error(
        `${fileName}:${item.number} ends at ${feature.end.toLocaleString()}, beyond ${fastaName} (${sequenceLength.toLocaleString()} bp).`,
      );
    }
    features.push(feature);
  }
  if (features.length === 0) {
    const examples = [...observedNames].slice(0, 4).join(", ");
    throw new Error(
      `${fileName} does not contain features named for ${fastaName}. Found: ${examples || "no sequence names"}.`,
    );
  }
  features.sort((left, right) => left.start - right.start || left.end - right.end);
  return {
    fileName,
    sequenceName: fastaName,
    format,
    features,
  };
}

function parseBed(fields: string[], fileName: string, line: number): TrackFeature {
  if (fields.length < 3) throw new Error(`${fileName}:${line} must have at least three BED columns.`);
  const start = integer(fields[1], fileName, line);
  const end = integer(fields[2], fileName, line);
  const name = fields[3]?.trim() || `feature ${line}`;
  const strand = parseStrand(fields[5]);
  const blocks: FeatureBlock[] = [];
  if (fields.length >= 12) {
    const count = integer(fields[9], fileName, line);
    const sizes = splitIntegers(fields[10] ?? "", fileName, line);
    const starts = splitIntegers(fields[11] ?? "", fileName, line);
    if (sizes.length !== count || starts.length !== count) {
      throw new Error(`${fileName}:${line} BED12 block count does not match its block arrays.`);
    }
    for (let index = 0; index < count; index += 1) {
      const blockStart = start + (starts[index] ?? 0);
      blocks.push({ start: blockStart, end: blockStart + (sizes[index] ?? 0), kind: "block" });
    }
  }
  if (fields.length >= 8) {
    const thickStart = integer(fields[6], fileName, line);
    const thickEnd = integer(fields[7], fileName, line);
    if (thickEnd > thickStart) blocks.push({ start: thickStart, end: thickEnd, kind: "thick" });
  }
  return { start, end, name, type: fields.length >= 12 ? "transcript" : "feature", strand, group: name, blocks };
}

function parseGff(fields: string[], fileName: string, line: number): TrackFeature {
  if (fields.length !== 9) throw new Error(`${fileName}:${line} must have nine GFF/GTF columns.`);
  const start = integer(fields[3], fileName, line) - 1;
  const end = integer(fields[4], fileName, line);
  const attributes = parseAttributes(fields[8] ?? "");
  const type = fields[2]?.toLowerCase() || "feature";
  const name = attributes.get("Name") ?? attributes.get("gene_name") ?? attributes.get("ID") ?? attributes.get("gene_id") ?? `${type} ${line}`;
  const group = attributes.get("Parent") ?? attributes.get("transcript_id") ?? attributes.get("gene_id") ?? attributes.get("ID") ?? name;
  const kind = type === "cds" ? "thick" : "block";
  return {
    start,
    end,
    name,
    type,
    strand: parseStrand(fields[6]),
    group,
    blocks: type === "exon" || type === "cds" ? [{ start, end, kind }] : [],
  };
}

function parseAttributes(value: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const entry of value.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    if (equals >= 0) {
      attributes.set(trimmed.slice(0, equals), decodeURIComponent(trimmed.slice(equals + 1)));
      continue;
    }
    const match = trimmed.match(/^(\S+)\s+"?(.+?)"?$/);
    if (match?.[1] && match[2]) attributes.set(match[1], match[2].replace(/^"|"$/g, ""));
  }
  return attributes;
}

function integer(value: string | undefined, fileName: string, line: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${fileName}:${line} contains a non-integer coordinate.`);
  return parsed;
}

function splitIntegers(value: string, fileName: string, line: number): number[] {
  return value.split(",").filter(Boolean).map((item) => integer(item, fileName, line));
}

function parseStrand(value: string | undefined): "+" | "-" | "." {
  return value === "+" || value === "-" ? value : ".";
}
