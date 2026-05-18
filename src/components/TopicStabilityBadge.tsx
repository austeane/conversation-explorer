export function TopicStabilityBadge({ value }: { value: number | null | undefined }) {
  if (value == null) return null;
  const tone = value >= 0.8 ? "stable" : value >= 0.6 ? "watch" : "low";
  const label = tone === "stable" ? "stable" : tone === "watch" ? "watch" : "low stability";
  return (
    <span className={`topic-stability-badge ${tone}`} title={`Topic stability ${Math.round(value * 100)}%`}>
      {label} {Math.round(value * 100)}%
    </span>
  );
}
