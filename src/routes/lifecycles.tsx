import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { TopicStabilityBadge } from "~/components/TopicStabilityBadge";
import { fmtDate, fmtInt } from "~/lib/format";
import {
  getLifecycles,
  type LifecycleArchetype,
  type LifecycleMonth,
  type LifecycleReturn,
  type LifecycleTopic,
  type SurvivalPoint,
} from "~/server/lifecycle-queries";

export const Route = createFileRoute("/lifecycles")({
  loader: async () => getLifecycles(),
  component: LifecyclesPage,
});

function LifecyclesPage() {
  const data = Route.useLoaderData();
  const maxSegments = Math.max(...data.months.map((month) => month.segments), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Topic ecology</div>
        <PageTitleRow activePath="/lifecycles" />
        <p className="page-lede">
          Subjects enter, bloom, go quiet, return after dormancy, or become part of the
          permanent weather of the conversation.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.topics,
            version: `lifecycles-${String(data.overview.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Full-archive topic view; date and sender filters would require rebuilding the topic timeline.",
              "HDBSCAN outlier segments are excluded from topic lifecycles.",
              "Dormancy and archetype labels come from fixed thresholds.",
              "Each topic is assigned to a single archetype using priority order: faded, newcomer, comet, resurrected, evergreen.",
              "The photo_sharing topic is filtered out — it is a catch-all for attachment-bearing messages, not a coherent theme.",
            ],
          }}
          confidence="medium"
        />
      </div>

      <div className="stat-grid">
        <Stat label="Topics tracked" value={fmtInt(data.overview.topics)} note={`${fmtInt(data.overview.months)} active / ${fmtInt(data.overview.month_span)} month span`} />
        <Stat label="Evergreens" value={fmtInt(data.overview.evergreen_topics)} note="steady recurrence" />
        <Stat label="Resurrections" value={fmtInt(data.overview.resurrected_topics)} note="returned after dormancy" />
        <Stat label="Longest dormancy" value={data.overview.longest_dormancy} note="topic return gap" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly ecology</h2>
        <div className="panel lifecycle-month-panel">
          <div className="hint">
            Bars are segment volume. Overlays mark topic births, returns after a three-month gap,
            and endings.
          </div>
          <div className="lifecycle-month-scroll">
            <div className="lifecycle-month-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(10px, 1fr))` }}>
              {data.months.map((month) => (
                <MonthColumn key={month.ym} month={month} maxSegments={maxSegments} />
              ))}
            </div>
            <div className="restart-axis">
              <span>{data.months[0]?.ym}</span>
              <span>{data.months[data.months.length - 1]?.ym}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Survival curve</h2>
        <div className="panel lifecycle-survival-panel">
          {data.survival.map((point) => (
            <SurvivalRow key={point.month_offset} point={point} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Archetypes</h2>
        <div className="lifecycle-archetype-grid">
          {data.archetypes.length > 0 ? (
            data.archetypes.map((archetype) => (
              <ArchetypeCard key={archetype.key} archetype={archetype} />
            ))
          ) : (
            <div className="panel lifecycle-empty">No topic archetypes matched the current thresholds.</div>
          )}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Dormant returns</h2>
        <div className="lifecycle-return-grid">
          {data.returns.map((item) => (
            <ReturnCard key={`${item.topic.topic_id}-${item.to_ym}`} item={item} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">05</span> Topic evidence</h2>
        <div className="lifecycle-topic-grid">
          {data.examples.map((topic) => (
            <TopicCard key={topic.topic_id} topic={topic} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.overview.generated_at)}. Method:
        monthly topic incidence from `seg_segments` and `seg_topics`, contiguous month indexing,
        three-month dormancy thresholds, survival-by-offset, and representative segment snippets.
      </p>
    </div>
  );
}

function MonthColumn({ month, maxSegments }: { month: LifecycleMonth; maxSegments: number }) {
  const height = Math.max(3, (month.segments / maxSegments) * 100);
  return (
    <div
      className="lifecycle-month-column"
      title={`${month.ym}: ${fmtInt(month.active_topics)} active topics, ${fmtInt(month.new_topics)} new, ${fmtInt(month.returning_topics)} returns, ${fmtInt(month.ending_topics)} endings`}
    >
      <span className="lifecycle-volume" style={{ height: `${height}%` }} />
      <i className="births" style={{ height: `${markerHeight(month.new_topics, month.active_topics)}%` }} />
      <i className="returns" style={{ height: `${markerHeight(month.returning_topics, month.active_topics)}%` }} />
      <i className="endings" style={{ height: `${markerHeight(month.ending_topics, month.active_topics)}%` }} />
    </div>
  );
}

function SurvivalRow({ point }: { point: SurvivalPoint }) {
  return (
    <div className="lifecycle-survival-row">
      <span>{point.month_offset}m</span>
      <div>
        <i style={{ width: `${Math.max(2, point.survival_rate * 100)}%` }} />
      </div>
      <strong>{formatPct(point.survival_rate)}</strong>
      <small>{fmtInt(point.surviving_topics)} / {fmtInt(point.eligible_topics)}</small>
    </div>
  );
}

function ArchetypeCard({ archetype }: { archetype: LifecycleArchetype }) {
  return (
    <article className="panel lifecycle-archetype-card">
      <div className="lifecycle-card-head">
        <div>
          <div className="turn-block-title">{archetype.label}</div>
          <p>{archetype.description}</p>
        </div>
        <strong>{fmtInt(archetype.count)}</strong>
      </div>
      <div className="lifecycle-topic-list">
        {archetype.topics.length > 0 ? (
          archetype.topics.map((topic) => (
            <TopicMini key={topic.topic_id} topic={topic} />
          ))
        ) : (
          <div className="lifecycle-empty">No topics matched this profile.</div>
        )}
      </div>
    </article>
  );
}

function ReturnCard({ item }: { item: LifecycleReturn }) {
  return (
    <article className="panel lifecycle-return-card">
      <div className="lifecycle-card-head compact">
        <div>
          <div className="turn-block-title">{item.topic.label}</div>
          <p>{item.topic.category}</p>
        </div>
        <strong>{item.gap_months}m</strong>
      </div>
      <div className="lifecycle-return-line">
        <span>{item.from_ym}</span>
        <i />
        <span>{item.to_ym}</span>
      </div>
      <TopicMini topic={item.topic} />
    </article>
  );
}

function TopicCard({ topic }: { topic: LifecycleTopic }) {
  return (
    <article className="panel lifecycle-topic-card">
      <div className="lifecycle-card-head">
        <div>
          <div className="turn-block-title">{topic.label}</div>
          <p>{topic.category}</p>
        </div>
        <strong>{fmtInt(topic.segments)}</strong>
      </div>
      <TopicMetrics topic={topic} />
      <KeywordList topic={topic} />
      <div className="lifecycle-snippets">
        {topic.snippets.map((snippet) => (
          <div key={`${topic.topic_id}-${snippet.ts}-${snippet.text}`}>
            <span>{snippet.sender} · {fmtDate(snippet.ts, { withTime: true })}</span>
            <p>{snippet.text}</p>
            <EvidenceLink
              evidence={{
                label: "Open day in Browse",
                date: snippet.ymd,
                note: `${topic.label} evidence`,
              }}
            />
          </div>
        ))}
      </div>
    </article>
  );
}

function TopicMini({ topic }: { topic: LifecycleTopic }) {
  return (
    <div className="lifecycle-topic-mini">
      <div>
        <strong>{topic.label}</strong>
        <span>{topic.first_ym} -&gt; {topic.last_ym}</span>
      </div>
      <TopicMetrics topic={topic} compact />
      <KeywordList topic={topic} />
    </div>
  );
}

function TopicMetrics({ topic, compact = false }: { topic: LifecycleTopic; compact?: boolean }) {
  return (
    <div className={compact ? "lifecycle-metrics compact" : "lifecycle-metrics"}>
      <div><span>active</span><strong>{topic.active_months}m</strong></div>
      <div><span>span</span><strong>{topic.span_months}m</strong></div>
      <div><span>density</span><strong>{formatPct(topic.density)}</strong></div>
      <div><span>sleep</span><strong>{topic.max_dormancy_months}m</strong></div>
      <div><span>returns</span><strong>{topic.returns}</strong></div>
      <div><span>Me</span><strong>{formatPct(topic.me_share)}</strong></div>
      <div><span>stability</span><strong><TopicStabilityBadge value={topic.topic_stability} /></strong></div>
    </div>
  );
}

function KeywordList({ topic }: { topic: LifecycleTopic }) {
  return (
    <div className="lifecycle-keywords">
      {topic.keywords.slice(0, 5).map((keyword) => (
        <span key={`${topic.topic_id}-${keyword}`}>{keyword}</span>
      ))}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

function markerHeight(part: number, whole: number) {
  return Math.max(0, Math.min(100, whole === 0 ? 0 : (part / whole) * 100));
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
