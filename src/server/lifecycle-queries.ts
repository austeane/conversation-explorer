import { createServerFn } from "@tanstack/react-start";
import { bucket } from "~/lib/conversation/time";
import { excludedTopicLabelSqlAnd } from "~/lib/conversation/topic-hygiene";
import { db, withDbCache } from "~/lib/server-db";
import { topicStabilitySql } from "~/server/topic-stability";

const RETURN_GAP_MONTHS = 3;
const MAX_ARCHETYPE_TOPICS = 4;
const MAX_RETURNS = 14;
const MAX_EXAMPLES = 16;

export type Sender = "Me" | "Them";

export type LifecycleOverview = {
  generated_at: string;
  topics: number;
  months: number;
  month_span: number;
  evergreen_topics: number;
  resurrected_topics: number;
  longest_dormancy: string;
  newest_topic: string;
};

export type LifecycleMonth = {
  ym: string;
  active_topics: number;
  new_topics: number;
  returning_topics: number;
  ending_topics: number;
  segments: number;
};

export type SurvivalPoint = {
  month_offset: number;
  eligible_topics: number;
  surviving_topics: number;
  survival_rate: number;
};

export type LifecycleSnippet = {
  ts: number;
  ymd: string;
  sender: Sender;
  text: string;
};

export type LifecycleTopic = {
  topic_id: number;
  label: string;
  category: string;
  first_ts: number;
  last_ts: number;
  first_ym: string;
  last_ym: string;
  segments: number;
  messages: number;
  active_months: number;
  span_months: number;
  density: number;
  peak_ym: string;
  peak_segments: number;
  max_dormancy_months: number;
  returns: number;
  me_share: number;
  topic_stability: number | null;
  keywords: string[];
  snippets: LifecycleSnippet[];
};

export type LifecycleArchetype = {
  key: string;
  label: string;
  description: string;
  count: number;
  topics: LifecycleTopic[];
};

export type LifecycleReturn = {
  topic: LifecycleTopic;
  gap_months: number;
  from_ym: string;
  to_ym: string;
};

export type LifecycleResult = {
  overview: LifecycleOverview;
  months: LifecycleMonth[];
  survival: SurvivalPoint[];
  archetypes: LifecycleArchetype[];
  returns: LifecycleReturn[];
  examples: LifecycleTopic[];
};

type TopicSegmentRow = {
  id: number;
  topic_id: number;
  start_ts: number;
  end_ts: number;
  ym: string;
  n_msgs: number;
  n_me: number;
  n_them: number;
  topic_label: string | null;
  top_words: string | null;
  top_phrases: string | null;
  representative_segment_id: number | null;
  category: string | null;
  topic_stability: number | null;
  topic_stability_min: number | null;
};

type TopicBuild = LifecycleTopic & {
  active_indices: number[];
  representative_segment_id: number;
  month_segments: Record<string, number>;
};

type SnippetRow = {
  ts: number;
  is_from_me: number;
  text: string | null;
};

export const getLifecycles = createServerFn({ method: "GET" }).handler(
  async (): Promise<LifecycleResult> => {
    return withDbCache("lifecycles", () => {
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const rawRows = db()
        .prepare(
          `
          ${(() => {
            const stability = topicStabilitySql("s.topic_id", "lifecycle_stability");
            return `
          SELECT
            s.id,
            s.topic_id,
            s.start_ts,
            s.end_ts,
            s.n_msgs,
            s.n_me,
            s.n_them,
            t.label AS topic_label,
            t.top_words,
            t.top_phrases,
            t.representative_segment_id,
            COALESCE(sc.category, tc.category, t.label, 'unlabeled') AS category,
            ${stability.select}
          FROM seg_segments s
          JOIN seg_topics t ON t.id = s.topic_id
          LEFT JOIN seg_topic_categories tc ON tc.topic_id = s.topic_id
          LEFT JOIN seg_segment_categories sc ON sc.segment_id = s.id
          ${stability.join}
          WHERE s.topic_id IS NOT NULL
            ${excludedTopicLabelSqlAnd("t.label")}
          ORDER BY s.start_ts ASC, s.id ASC
        `;
          })()}
        `,
        )
        .all() as Array<Omit<TopicSegmentRow, "ym">>;
      const rows: TopicSegmentRow[] = rawRows.map((row) => ({ ...row, ym: bucket(row.start_ts, "ym") }));

      const monthList = contiguousMonths(rows.map((row) => row.ym));
      const activeMonthCount = new Set(rows.map((row) => row.ym)).size;
      const firstMonthIndex = ymToIndex(monthList[0] ?? "2020-01");
      const latestIndex = ymToIndex(monthList[monthList.length - 1] ?? "2020-01") - firstMonthIndex;
      const topics = buildTopics(rows, firstMonthIndex);
      const archetypes = buildArchetypes(topics, latestIndex).filter((archetype) => archetype.count > 0);
      const returns = buildReturns(topics, firstMonthIndex);
      const examples = chooseExamples(archetypes, returns, topics);
      const hydratedIds = new Set<number>();

      for (const archetype of archetypes) {
        for (const topic of archetype.topics) hydratedIds.add(topic.topic_id);
      }
      for (const item of returns.slice(0, MAX_RETURNS)) hydratedIds.add(item.topic.topic_id);
      for (const topic of examples) hydratedIds.add(topic.topic_id);
      hydrateSnippets(topics.filter((topic) => hydratedIds.has(topic.topic_id)));

      const evergreenCount = archetypes.find((archetype) => archetype.key === "evergreen")?.count ?? 0;
      const resurrectedCount = archetypes.find((archetype) => archetype.key === "resurrected")?.count ?? 0;
      const longestReturn = returns[0];
      const newestTopic = [...topics]
        .sort((a, b) => b.active_indices[0] - a.active_indices[0] || b.segments - a.segments)[0];

      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          topics: topics.length,
          months: activeMonthCount,
          month_span: monthList.length,
          evergreen_topics: evergreenCount,
          resurrected_topics: resurrectedCount,
          longest_dormancy: longestReturn ? `${longestReturn.topic.label} (${longestReturn.gap_months} months)` : "n/a",
          newest_topic: newestTopic?.label ?? "n/a",
        },
        months: buildMonths(monthList, topics, firstMonthIndex),
        survival: buildSurvival(topics, latestIndex),
        archetypes,
        returns: returns.slice(0, MAX_RETURNS),
        examples,
      };
    });
  },
);

function buildTopics(rows: TopicSegmentRow[], firstMonthIndex: number): TopicBuild[] {
  const grouped = groupBy(rows, (row) => String(row.topic_id));
  return [...grouped.values()]
    .map((topicRows) => {
      const ordered = topicRows.slice().sort((a, b) => a.start_ts - b.start_ts || a.id - b.id);
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const monthCounts = new Map<string, number>();
      const monthMessages = new Map<string, number>();
      for (const row of ordered) {
        monthCounts.set(row.ym, (monthCounts.get(row.ym) ?? 0) + 1);
        monthMessages.set(row.ym, (monthMessages.get(row.ym) ?? 0) + row.n_msgs);
      }
      const activeIndices = [...monthCounts.keys()]
        .map((ym) => ymToIndex(ym) - firstMonthIndex)
        .sort((a, b) => a - b);
      const peak = [...monthCounts.entries()].sort((a, b) => b[1] - a[1] || (monthMessages.get(b[0]) ?? 0) - (monthMessages.get(a[0]) ?? 0))[0];
      const messages = sum(ordered.map((row) => row.n_msgs));
      const me = sum(ordered.map((row) => row.n_me));
      const gaps = dormancyGaps(activeIndices);
      const representativeId = first.representative_segment_id && ordered.some((row) => row.id === first.representative_segment_id)
        ? first.representative_segment_id
        : bestSegmentId(ordered, peak?.[0]);
      const spanMonths = activeIndices[activeIndices.length - 1] - activeIndices[0] + 1;

      return {
        topic_id: first.topic_id,
        label: topicTitle(first),
        category: cleanCategory(mostCommon(ordered.map((row) => row.category ?? "unlabeled"))),
        first_ts: first.start_ts,
        last_ts: last.end_ts,
        first_ym: first.ym,
        last_ym: last.ym,
        segments: ordered.length,
        messages,
        active_months: activeIndices.length,
        span_months: spanMonths,
        density: activeIndices.length / Math.max(1, spanMonths),
        peak_ym: peak?.[0] ?? first.ym,
        peak_segments: peak?.[1] ?? ordered.length,
        max_dormancy_months: Math.max(0, ...gaps.map((gap) => gap.gapMonths)),
        returns: gaps.filter((gap) => gap.gapMonths >= RETURN_GAP_MONTHS).length,
        me_share: messages === 0 ? 0 : me / messages,
        topic_stability: first.topic_stability == null ? null : round(first.topic_stability),
        keywords: keywordsFromRow(first),
        snippets: [],
        active_indices: activeIndices,
        representative_segment_id: representativeId,
        month_segments: Object.fromEntries(monthCounts.entries()),
      };
    })
    .sort((a, b) => b.segments - a.segments);
}

function buildArchetypes(topics: TopicBuild[], latestIndex: number): LifecycleArchetype[] {
  const specs = [
    {
      key: "evergreen",
      label: "Evergreen",
      description: "Topics with broad spans, many active months, and steady recurrence.",
      test: (topic: TopicBuild) => topic.span_months >= 24 && topic.active_months >= 18 && topic.density >= 0.28,
      rank: (topic: TopicBuild) => topic.active_months * 3 + topic.segments + topic.density * 20,
    },
    {
      key: "resurrected",
      label: "Resurrected",
      description: "Subjects that vanish for a season and then come back into the thread.",
      test: (topic: TopicBuild) => topic.max_dormancy_months >= 8 && topic.returns > 0,
      rank: (topic: TopicBuild) => topic.max_dormancy_months * 5 + topic.returns * 12 + topic.segments,
    },
    {
      key: "comet",
      label: "Comets",
      description: "Short-lived but intense subjects that burn hot in a narrow window.",
      test: (topic: TopicBuild) => topic.active_months <= 5 && topic.segments >= 12 && topic.peak_segments >= Math.max(5, topic.segments * 0.35),
      rank: (topic: TopicBuild) => topic.peak_segments * 4 + topic.segments - topic.active_months,
    },
    {
      key: "newcomer",
      label: "Recent arrivals",
      description: "Topics whose first appearance is close to the current edge of the archive.",
      test: (topic: TopicBuild) => latestIndex - topic.active_indices[0] <= 9 && topic.segments >= 4,
      rank: (topic: TopicBuild) => topic.active_indices[0] * 2 + topic.segments,
    },
    {
      key: "faded",
      label: "Faded",
      description: "Once-recurring subjects that have not appeared near the present.",
      test: (topic: TopicBuild) => latestIndex - topic.active_indices[topic.active_indices.length - 1] >= 10 && topic.active_months >= 5,
      rank: (topic: TopicBuild) => (latestIndex - topic.active_indices[topic.active_indices.length - 1]) * 3 + topic.active_months,
    },
  ];

  // Each topic lands in exactly one archetype: most-specific wins. Faded captures terminal
  // state, then Newcomer captures arrivals, then the behavioral shapes (Comet, Resurrected),
  // and Evergreen is the catch-all for broad persistent topics that lack a sharper story.
  const ASSIGNMENT_PRIORITY = ["faded", "newcomer", "comet", "resurrected", "evergreen"] as const;
  const byPriority = ASSIGNMENT_PRIORITY.map((key) => specs.find((spec) => spec.key === key)!).filter(Boolean);
  const claimed = new Map<number, string>();
  for (const topic of topics) {
    for (const spec of byPriority) {
      if (spec.test(topic)) {
        claimed.set(topic.topic_id, spec.key);
        break;
      }
    }
  }

  return specs.map((spec) => {
    const matching = topics
      .filter((topic) => claimed.get(topic.topic_id) === spec.key)
      .sort((a, b) => spec.rank(b) - spec.rank(a));
    return {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      count: matching.length,
      topics: matching.slice(0, MAX_ARCHETYPE_TOPICS),
    };
  });
}

function buildReturns(topics: TopicBuild[], firstMonthIndex: number): LifecycleReturn[] {
  const returns: LifecycleReturn[] = [];
  for (const topic of topics) {
    for (let i = 1; i < topic.active_indices.length; i += 1) {
      const gapMonths = topic.active_indices[i] - topic.active_indices[i - 1] - 1;
      if (gapMonths < RETURN_GAP_MONTHS) continue;
      returns.push({
        topic,
        gap_months: gapMonths,
        from_ym: indexToYm(topic.active_indices[i - 1] + firstMonthIndex),
        to_ym: indexToYm(topic.active_indices[i] + firstMonthIndex),
      });
    }
  }
  return returns.sort((a, b) => b.gap_months - a.gap_months || b.topic.segments - a.topic.segments);
}

function chooseExamples(archetypes: LifecycleArchetype[], returns: LifecycleReturn[], topics: TopicBuild[]) {
  const chosen: LifecycleTopic[] = [];
  const seen = new Set<number>();
  for (const archetype of archetypes) {
    for (const topic of archetype.topics.slice(0, 2)) addTopic(chosen, seen, topic);
  }
  for (const item of returns.slice(0, 4)) addTopic(chosen, seen, item.topic);
  for (const topic of topics.slice(0, 4)) addTopic(chosen, seen, topic);
  return chosen.slice(0, MAX_EXAMPLES);
}

function addTopic(chosen: LifecycleTopic[], seen: Set<number>, topic: LifecycleTopic) {
  if (seen.has(topic.topic_id)) return;
  seen.add(topic.topic_id);
  chosen.push(topic);
}

function hydrateSnippets(topics: TopicBuild[]) {
  const stmt = db().prepare(
    `
    SELECT m.ts, m.is_from_me, m.text
    FROM seg_msg_segment sms
    JOIN messages m ON m.id = sms.msg_id
    WHERE sms.segment_id = ?
      AND m.text IS NOT NULL
      AND trim(m.text) != ''
    ORDER BY m.ts ASC, m.id ASC
    LIMIT 4
  `,
  );
  for (const topic of topics) {
    const rows = stmt.all(topic.representative_segment_id) as SnippetRow[];
    topic.snippets = rows.map((row) => ({
      ts: row.ts,
      ymd: bucket(row.ts, "ymd"),
      sender: row.is_from_me ? "Me" : "Them",
      text: preview(row.text),
    }));
  }
}

function buildMonths(monthList: string[], topics: TopicBuild[], firstMonthIndex: number): LifecycleMonth[] {
  const months = monthList.map((ym) => ({
    ym,
    active_topics: 0,
    new_topics: 0,
    returning_topics: 0,
    ending_topics: 0,
    segments: 0,
  }));
  const monthByIndex = new Map(months.map((month, offset) => [ymToIndex(month.ym) - firstMonthIndex, { month, offset }]));

  for (const topic of topics) {
    for (let i = 0; i < topic.active_indices.length; i += 1) {
      const entry = monthByIndex.get(topic.active_indices[i]);
      if (!entry) continue;
      entry.month.active_topics += 1;
      entry.month.segments += topic.month_segments[entry.month.ym] ?? 0;
      if (i === 0) entry.month.new_topics += 1;
      if (i > 0 && topic.active_indices[i] - topic.active_indices[i - 1] - 1 >= RETURN_GAP_MONTHS) {
        entry.month.returning_topics += 1;
      }
      if (i === topic.active_indices.length - 1) entry.month.ending_topics += 1;
    }
  }

  return months;
}

function buildSurvival(topics: TopicBuild[], latestIndex: number): SurvivalPoint[] {
  const offsets = [3, 6, 9, 12, 18, 24, 30, 36, 42, 48, 54, 60];
  return offsets
    .map((offset) => {
      const eligible = topics.filter((topic) => topic.active_indices[0] + offset <= latestIndex);
      const surviving = eligible.filter((topic) => topic.active_indices[topic.active_indices.length - 1] - topic.active_indices[0] >= offset);
      return {
        month_offset: offset,
        eligible_topics: eligible.length,
        surviving_topics: surviving.length,
        survival_rate: eligible.length === 0 ? 0 : surviving.length / eligible.length,
      };
    })
    .filter((point) => point.eligible_topics > 0);
}

function dormancyGaps(activeIndices: number[]) {
  const gaps: Array<{ from: number; to: number; gapMonths: number }> = [];
  for (let i = 1; i < activeIndices.length; i += 1) {
    const gapMonths = activeIndices[i] - activeIndices[i - 1] - 1;
    if (gapMonths > 0) gaps.push({ from: activeIndices[i - 1], to: activeIndices[i], gapMonths });
  }
  return gaps;
}

function bestSegmentId(rows: TopicSegmentRow[], peakYm: string | undefined) {
  const candidates = peakYm ? rows.filter((row) => row.ym === peakYm) : rows;
  return candidates.slice().sort((a, b) => b.n_msgs - a.n_msgs || a.start_ts - b.start_ts)[0]?.id ?? rows[0].id;
}

function contiguousMonths(values: string[]) {
  const unique = [...new Set(values)].sort();
  if (!unique.length) return [];
  const start = ymToIndex(unique[0]);
  const end = ymToIndex(unique[unique.length - 1]);
  const months: string[] = [];
  for (let index = start; index <= end; index += 1) months.push(indexToYm(index));
  return months;
}

function ymToIndex(ym: string) {
  const [year, month] = ym.split("-").map(Number);
  return year * 12 + month - 1;
}

function indexToYm(index: number) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function topicTitle(row: TopicSegmentRow) {
  const base = cleanCategory(row.topic_label ?? row.category ?? "topic");
  const phrases = parseList(row.top_phrases);
  const words = parseList(row.top_words);
  const detail = [...phrases, ...words].filter((item) => item.length > 2 && item !== base).slice(0, 2).join(", ");
  return detail ? `${base}: ${detail}` : base;
}

function keywordsFromRow(row: TopicSegmentRow) {
  return [...parseList(row.top_phrases), ...parseList(row.top_words)]
    .filter((item, index, arr) => item.length > 2 && arr.indexOf(item) === index)
    .slice(0, 7);
}

function parseList(value: string | null) {
  const raw = (value ?? "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => cleanCategory(String(item)))
          .filter(Boolean);
      }
    } catch {
      // Fall through to delimiter parsing for older generated strings.
    }
  }
  return raw
    .split(/[,|]/)
    .map((item) => cleanCategory(item))
    .filter(Boolean);
}

function cleanCategory(value: string) {
  return value
    .replace(/[[\]"]/g, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "unlabeled";
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function preview(text: string | null) {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  return cleaned.length > 190 ? `${cleaned.slice(0, 187)}...` : cleaned;
}
