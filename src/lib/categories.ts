export type CategoryStatus = "classified" | "low_signal" | "topic_outlier" | "no_text" | "ambiguous";

export type CategoryReason =
  | "lexical_score"
  | "topic_majority"
  | "hdbscan_outlier"
  | "fallback"
  | "non_text";

export type CategoryStatusMeta = {
  label: string;
  group: "classified" | "uncertain";
  description: string;
};

export const UNCERTAIN_CATEGORY = "unclassified";

export const STATUS_GROUPS: Record<CategoryStatus, CategoryStatusMeta> = {
  classified: {
    label: "Classified",
    group: "classified",
    description: "The segment has enough signal for a primary category.",
  },
  ambiguous: {
    label: "Ambiguous",
    group: "uncertain",
    description: "The segment has a primary category, but the top two scores are too close to treat as settled.",
  },
  low_signal: {
    label: "Low signal",
    group: "uncertain",
    description: "The segment has text, but no category earned the minimum lexical score.",
  },
  topic_outlier: {
    label: "Topic outlier",
    group: "uncertain",
    description: "The topic model marked the segment as HDBSCAN -1, so it is not forced into small talk.",
  },
  no_text: {
    label: "No text",
    group: "uncertain",
    description: "The segment has no ordinary text to classify, such as attachment-only rows.",
  },
};

export function categoryBucket(category: string | null | undefined, status?: string | null) {
  if (!category) return UNCERTAIN_CATEGORY;
  if (!status) return category;
  return status === "classified" ? category : UNCERTAIN_CATEGORY;
}

export function categoryStatusLabel(status: string | null | undefined) {
  if (!status) return STATUS_GROUPS.classified.label;
  return STATUS_GROUPS[status as CategoryStatus]?.label ?? status.replace(/_/g, " ");
}

