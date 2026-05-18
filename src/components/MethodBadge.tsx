import { confidenceFor, methodLabel, type Confidence, type MethodMeta } from "~/lib/method";

export function MethodBadge({
  meta,
  confidence,
  showConfidence = true,
}: {
  meta: MethodMeta;
  confidence?: Confidence;
  showConfidence?: boolean;
}) {
  const resolvedConfidence = confidence ?? confidenceFor(meta);

  return (
    <span className={`method-badge method-${meta.kind} confidence-${resolvedConfidence}`}>
      <span>{methodLabel(meta.kind)}</span>
      {showConfidence && <strong>{resolvedConfidence}</strong>}
      {typeof meta.sample === "number" && <span>n={meta.sample.toLocaleString("en-US")}</span>}
    </span>
  );
}
