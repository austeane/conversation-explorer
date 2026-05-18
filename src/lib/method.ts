export type MethodKind = "descriptive" | "heuristic" | "observational" | "predictive" | "speculative";

export type Confidence = "high" | "medium" | "low";

export type MethodMeta = {
  kind: MethodKind;
  sample?: number;
  ci?: { low: number; high: number; nullValue?: number };
  evalF1?: number;
  version?: string;
  caveats?: string[];
};

export function confidenceFor(meta: MethodMeta): Confidence {
  const sample = meta.sample ?? 0;
  const caveats = meta.caveats ?? [];
  const ciExcludesNull =
    !meta.ci ||
    meta.ci.high < (meta.ci.nullValue ?? 0) ||
    meta.ci.low > (meta.ci.nullValue ?? 0);
  const evalPasses = meta.evalF1 == null || meta.evalF1 >= 0.75;

  if (meta.kind === "speculative" || sample < 30 || caveats.length >= 3) return "low";
  if (sample >= 80 && ciExcludesNull && evalPasses && meta.kind !== "heuristic") return "high";
  if (sample >= 30 && ciExcludesNull) return "medium";
  return "low";
}

export function methodLabel(kind: MethodKind) {
  switch (kind) {
    case "descriptive":
      return "Descriptive";
    case "heuristic":
      return "Heuristic";
    case "observational":
      return "Observational";
    case "predictive":
      return "Predictive";
    case "speculative":
      return "Speculative";
  }
}
