import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getTurningPoints,
  type CategorySurge,
  type TopicArrival,
  type TurningPointCategory,
  type TurningPointMonth,
  type TurningPointSegment,
} from "~/server/turning-point-queries";

export const Route = createFileRoute("/turning-points")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getTurningPoints({ data: deps }),
  component: TurningPointsPage,
});

function TurningPointsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const topMonth = data.top_months[0];
  const strongestSurge =
    data.category_surges.find((surge) => surge.category !== "small_talk" && surge.category !== "unclassified") ??
    data.category_surges[0];

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Inflection analysis</div>
        <PageTitleRow activePath="/turning-points" />
        <p className="page-lede">
          Months where the topic-category mix breaks from the previous{" "}
          {data.window_months} months. Divergence uses Jensen-Shannon distance over
          segmented conversation categories, so it catches changes in what the
          relationship is doing rather than only changes in volume.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.months_analyzed,
            version: `turning-points-${String(data.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Jensen-Shannon divergence is over classified segment categories.",
              "Representative segments are inspection anchors, not proof of what caused a shift.",
              "Filters include months with segments matching the selected message scope.",
            ],
          }}
          confidence="medium"
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, segments with ${search.sender}` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Months scanned" value={fmtInt(data.months_total)} note={`${fmtInt(data.months_analyzed)} analyzable`} />
        <Stat label="Sharpest turn" value={topMonth?.ym ?? "n/a"} note={topMonth ? scoreLabel(topMonth.divergence) : "no qualifying month"} />
        <Stat label="Rolling window" value={`${data.window_months} mo`} note={`min ${fmtInt(data.min_segments_per_month)} segments`} />
        <Stat label="Strongest surge" value={strongestSurge?.category ?? "n/a"} note={strongestSurge ? `${formatPct(strongestSurge.delta)} above baseline` : "no surge"} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Divergence over time</h2>
        <div className="panel">
          <div className="hint turn-chart-note">
            Taller bars mean that month's conversation categories were less like the recent
            rolling baseline. The score is bounded from 0 to 1, but real conversation drift
            usually lives in the lower part of that range.
          </div>
          <div className="turn-chart">
            <DivergenceBars months={data.monthly_divergence} />
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Most distinct months</h2>
        <div className="turn-card-grid">
          {data.top_months.map((month) => (
            <TurningMonthCard key={month.ym} month={month} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Category pressure fronts</h2>
        <div className="panel">
          <table className="turn-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Category</th>
                <th>Share</th>
                <th>Baseline</th>
                <th>Lift</th>
                <th>Segments</th>
              </tr>
            </thead>
            <tbody>
              {data.category_surges.map((surge) => (
                <CategorySurgeRow key={`${surge.ym}-${surge.category}`} surge={surge} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> New or resurfacing topics</h2>
        <div className="panel">
          <table className="turn-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Topic</th>
                <th>Share</th>
                <th>Segments</th>
                <th>Prior sighting</th>
                <th>Keywords</th>
              </tr>
            </thead>
            <tbody>
              {data.topic_arrivals.map((topic) => (
                <TopicArrivalRow key={`${topic.ym}-${topic.topic_id}`} topic={topic} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.generated_at)} from{" "}
        <code>seg_segments</code>, <code>seg_segment_categories</code>, and <code>seg_topics</code>.
      </p>
    </div>
  );
}

function TurningMonthCard({ month }: { month: TurningPointMonth }) {
  return (
    <article className="panel turn-card">
      <div className="turn-card-head">
        <div>
          <div className="turn-month">{month.ym}</div>
          <div className="hint">{fmtInt(month.total)} segments · baseline {fmtInt(month.baseline_total)}</div>
        </div>
        <div className="turn-score">{scoreLabel(month.divergence)}</div>
      </div>

      <div className="turn-block">
        <div className="turn-block-title">What moved</div>
        <div className="turn-category-list">
          {month.categories.slice(0, 4).map((category) => (
            <CategoryDelta key={category.category} category={category} />
          ))}
        </div>
      </div>

      <div className="turn-block">
        <div className="turn-block-title">Dominant topics</div>
        <div className="topic-chip-row">
          {month.topics.map((topic) => (
            <span className="topic-chip" key={topic.topic_id}>
              {topic.label ?? topic.top_words.slice(0, 3).join(" / ")}
              <span>{fmtInt(topic.n)}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="turn-block">
        <div className="turn-block-title">Representative segments</div>
        <div className="segment-teaser-list">
          {month.segments.map((segment) => (
            <SegmentTeaser key={segment.id} segment={segment} />
          ))}
        </div>
      </div>
    </article>
  );
}

function CategoryDelta({ category }: { category: TurningPointCategory }) {
  const width = Math.min(100, Math.max(3, Math.abs(category.delta) * 250));
  const positive = category.delta >= 0;
  return (
    <div className="turn-category-row">
      <div className="turn-category-meta">
        <span>{category.category}</span>
        <span>{positive ? "+" : ""}{formatPct(category.delta)}</span>
      </div>
      <div className="turn-delta-track">
        <div
          className={positive ? "turn-delta-bar positive" : "turn-delta-bar negative"}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="hint">
        {formatPct(category.share)} now · {formatPct(category.baseline_share)} baseline
      </div>
    </div>
  );
}

function SegmentTeaser({ segment }: { segment: TurningPointSegment }) {
  return (
    <div className="segment-teaser">
      <div className="segment-teaser-meta">
        <span>{segment.category}</span>
        <span>{fmtInt(segment.n_msgs)} msgs</span>
      </div>
      <div className="segment-teaser-topic">{segment.topic_label ?? "untitled topic"}</div>
      <p>{segment.preview || "No text preview available."}</p>
      <EvidenceLink
        evidence={{
          label: "Open segment in Browse",
          from: bucket(segment.start_ts, "ymd"),
          to: bucket(segment.end_ts, "ymd"),
          note: segment.topic_label ?? segment.category,
        }}
      />
    </div>
  );
}

function CategorySurgeRow({ surge }: { surge: CategorySurge }) {
  return (
    <tr>
      <td>{surge.ym}</td>
      <td>{surge.category}</td>
      <td>{formatPct(surge.share)}</td>
      <td>{formatPct(surge.baseline_share)}</td>
      <td className="turn-positive">+{formatPct(surge.delta)}</td>
      <td>{fmtInt(surge.n)}</td>
    </tr>
  );
}

function TopicArrivalRow({ topic }: { topic: TopicArrival }) {
  const prior =
    topic.months_since_seen == null ? "first qualifying month" : `${topic.months_since_seen} mo gap`;
  return (
    <tr>
      <td>{topic.ym}</td>
      <td>{topic.label ?? `Topic ${topic.topic_id}`}</td>
      <td>{formatPct(topic.share)}</td>
      <td>{fmtInt(topic.n)}</td>
      <td>{prior}</td>
      <td>{topic.top_words.join(", ")}</td>
    </tr>
  );
}

function DivergenceBars({ months }: { months: Array<{ ym: string; divergence: number; total: number }> }) {
  const max = Math.max(...months.map((month) => month.divergence), 0.001);
  return (
    <div className="turn-divergence-chart" role="img" aria-label="Monthly category divergence bars">
      <div className="turn-divergence-bars">
        {months.map((month) => (
          <div
            className="turn-divergence-column"
            key={month.ym}
            title={`${month.ym}: ${scoreLabel(month.divergence)}, ${fmtInt(month.total)} segments`}
          >
            <span style={{ height: `${Math.max(2, (month.divergence / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="restart-axis">
        <span>{months[0]?.ym}</span>
        <span>{months[months.length - 1]?.ym}</span>
      </div>
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

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function scoreLabel(value: number) {
  return value.toFixed(3);
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
