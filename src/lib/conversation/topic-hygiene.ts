// The topic model produced a giant cluster labeled "photo_sharing" (topic ids 0 and 44)
// whose only shared signal is that the messages carried image attachments. The actual
// text spans laundry talk, infusions, selfies, screenshots, jokes — there is no theme.
// Surfaces that treat topics or categories as semantic themes (lifecycles, constellation,
// atlas islands, gravity wells, seasonal categories, turning-point arrivals) hide it so
// the structural artefact does not crowd out the real subjects. Per-segment surfaces
// (browse, capsules, evidence) keep the tag because it is accurate at the message level.

const EXCLUDED = ["photo_sharing"] as const;

export const EXCLUDED_TOPIC_CATEGORIES: ReadonlySet<string> = new Set(EXCLUDED);

export const EXCLUDED_TOPIC_CAVEAT =
  "The photo_sharing topic is filtered out — it is a catch-all for attachment-bearing messages, not a coherent theme.";

export function isExcludedTopicCategory(value: string | null | undefined): boolean {
  return value != null && EXCLUDED_TOPIC_CATEGORIES.has(value);
}

// Returns a SQL fragment like "AND (t.label IS NULL OR t.label NOT IN ('photo_sharing'))".
// Values are compile-time constants so inlining is safe; better-sqlite3 cannot bind
// list parameters and these queries are not user-controlled.
export function excludedTopicLabelSqlAnd(columnExpr: string): string {
  const list = EXCLUDED.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
  return `AND (${columnExpr} IS NULL OR ${columnExpr} NOT IN (${list}))`;
}
