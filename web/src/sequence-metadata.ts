import type { SequenceMetadata } from "./protocol";

type SequenceWithoutSelectionId = Omit<SequenceMetadata, "selectionId">;

/** Assigns concise source-qualified identifiers that remain unique within one load. */
export function assignSequenceSelectionIds(
  sequences: readonly SequenceWithoutSelectionId[],
): SequenceMetadata[] {
  const used = new Set<string>();
  return sequences.map((sequence) => {
    const base = `${safePart(sequence.name)}_${safePart(fastaFileStem(sequence.sourceFile))}`;
    let selectionId = base;
    for (let suffix = 2; used.has(selectionId.toLowerCase()); suffix += 1) {
      selectionId = `${base}-${suffix}`;
    }
    used.add(selectionId.toLowerCase());
    return { ...sequence, selectionId };
  });
}

/** Full biological label used on the axes, without adding source-file noise. */
export function sequenceAxisLabel(sequence: Pick<SequenceMetadata, "name" | "description">): string {
  return sequence.description ? `${sequence.name} ${sequence.description}` : sequence.name;
}

export function fastaFileStem(fileName: string): string {
  return fileName
    .replace(/\.(?:gz|bgz|bgzf)$/i, "")
    .replace(/\.(?:fa|fasta|fna|fas)$/i, "") || "sequence";
}

function safePart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "sequence";
}
