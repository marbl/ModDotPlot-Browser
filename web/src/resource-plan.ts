export const RESOURCE_BUDGETS = Object.freeze({
  wasm: 3 * 1024 * 1024 * 1024,
  jsTiles: 96 * 1024 * 1024,
  gpuTextures: 96 * 1024 * 1024,
  annotations: 512 * 1024 * 1024,
  featureTracks: 64 * 1024 * 1024,
  transientPublication: 256 * 1024 * 1024,
  total: 4 * 1024 * 1024 * 1024,
});

export type ResourceClass = keyof Omit<typeof RESOURCE_BUDGETS, "total">;
export type ResourceAction = "admit" | "evict" | "downgrade" | "shard" | "spill" | "reject";

export interface ResourceUsage {
  wasm: number;
  jsTiles: number;
  gpuTextures: number;
  annotations: number;
  featureTracks: number;
  transientPublication: number;
}

export interface ResourceDecision {
  action: ResourceAction;
  resource: ResourceClass | "total";
  reason: string;
  fallback: string | null;
}

const FALLBACK: Record<ResourceClass, Exclude<ResourceAction, "admit" | "spill">> = {
  wasm: "downgrade",
  jsTiles: "evict",
  gpuTextures: "evict",
  annotations: "reject",
  featureTracks: "evict",
  transientPublication: "shard",
};

export function decideResourceAdmission(
  usage: ResourceUsage,
  resource: ResourceClass,
  requestedBytes: number,
): ResourceDecision {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 0) {
    return decision("reject", resource, "The allocation estimate is invalid.", null);
  }
  const projected = usage[resource] + requestedBytes;
  if (projected > RESOURCE_BUDGETS[resource]) {
    const action = FALLBACK[resource];
    return decision(
      action,
      resource,
      `${resource} would require ${projected.toLocaleString()} bytes, above its ${RESOURCE_BUDGETS[resource].toLocaleString()}-byte budget.`,
      fallbackText(action),
    );
  }
  const projectedTotal = totalResourceBytes(usage) + requestedBytes;
  if (projectedTotal > RESOURCE_BUDGETS.total) {
    return decision(
      "reject",
      "total",
      `The complete plan would require ${projectedTotal.toLocaleString()} bytes, above its ${RESOURCE_BUDGETS.total.toLocaleString()}-byte budget.`,
      "Reduce plot resolution, remove annotations, or load fewer sequences.",
    );
  }
  return decision("admit", resource, "The allocation fits the declared resource plan.", null);
}

export function totalResourceBytes(usage: ResourceUsage): number {
  return Object.values(usage).reduce((total, bytes) => total + bytes, 0);
}

function decision(
  action: ResourceAction,
  resource: ResourceClass | "total",
  reason: string,
  fallback: string | null,
): ResourceDecision {
  return { action, resource, reason, fallback };
}

function fallbackText(action: ResourceAction): string | null {
  switch (action) {
    case "evict":
      return "Evict least-recently-used nonvisible data before retrying.";
    case "downgrade":
      return "Use the lower-register preview tier or lower plot resolution.";
    case "shard":
      return "Publish the result in bounded chunks rather than cloning one complete graph.";
    case "reject":
      return "Reduce the request before retrying.";
    case "spill":
      return "Use bounded OPFS spill only after explicit browser support is measured.";
    case "admit":
      return null;
  }
}
