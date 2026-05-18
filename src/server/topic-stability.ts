import { db } from "~/lib/server-db";

export function topicStabilitySql(topicExpression: string, alias = "topic_stability") {
  const table = db()
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seg_topic_stability'")
    .get();

  if (!table) {
    return {
      select: "NULL AS topic_stability, NULL AS topic_stability_min",
      join: "",
    };
  }

  return {
    select: `${alias}.jaccard_mean AS topic_stability, ${alias}.jaccard_min AS topic_stability_min`,
    join: `LEFT JOIN seg_topic_stability ${alias} ON ${alias}.topic_id = ${topicExpression}`,
  };
}
