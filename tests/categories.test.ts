import { describe, expect, it } from "vitest";
import { STATUS_GROUPS, categoryBucket, categoryStatusLabel } from "~/lib/categories";

describe("category status taxonomy", () => {
  it("keeps classified categories while grouping uncertain statuses", () => {
    expect(categoryBucket("small_talk", "classified")).toBe("small_talk");
    expect(categoryBucket("planning", "classified")).toBe("planning");
    expect(categoryBucket("small_talk", "low_signal")).toBe("unclassified");
    expect(categoryBucket(null, "topic_outlier")).toBe("unclassified");
  });

  it("describes HDBSCAN outliers as uncertain instead of small talk", () => {
    expect(STATUS_GROUPS.topic_outlier.group).toBe("uncertain");
    expect(STATUS_GROUPS.topic_outlier.description).toContain("HDBSCAN -1");
    expect(categoryStatusLabel("topic_outlier")).toBe("Topic outlier");
  });
});

