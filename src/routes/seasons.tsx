import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtInt } from "~/lib/format";
import {
  getSeasons,
  type Season,
  type SeasonBreakpoint,
  type SeasonCategory,
  type SeasonMonth,
  type SeasonSegment,
  type SeasonTopic,
} from "~/server/season-queries";

export const Route = createFileRoute("/seasons")({
  loader: async () => getSeasons(),
  component: SeasonsPage,
});

function SeasonsPage() {
  const data = Route.useLoaderData();
  const longest = [...data.seasons].sort((a, b) => b.n_months - a.n_months)[0];
  const densest = [...data.seasons].sort((a, b) => b.avg_segments_per_month - a.avg_segments_per_month)[0];

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Phase portrait</div>
        <PageTitleRow activePath="/seasons" />
        <p className="page-lede">
          A change-point model partitions the archive into contiguous phases whose monthly
          category mixtures are internally coherent. This is not a volume chart; it is a map
          of when the conversation was doing different kinds of work.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.months_analyzed,
            version: `seasons-${String(data.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Full-archive phase model; date and sender filters would change the optimal partition.",
              "Season boundaries use category-mixture variance, not causal event detection.",
              "Sparse months below the support gate are excluded.",
            ],
          }}
          confidence="medium"
        />
      </div>

      <div className="stat-grid">
        <Stat label="Seasons" value={fmtInt(data.seasons.length)} note={`${fmtInt(data.months_analyzed)} months analyzed`} />
        <Stat label="Longest phase" value={longest ? rangeLabel(longest) : "n/a"} note={longest ? `${fmtInt(longest.n_months)} months` : "no data"} />
        <Stat label="Densest phase" value={densest ? rangeLabel(densest) : "n/a"} note={densest ? `${fmtInt(densest.avg_segments_per_month)} segments/month` : "no data"} />
        <Stat label="Min phase length" value={`${data.min_months_per_season} mo`} note="optimal contiguous partition" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Season ribbon</h2>
        <div className="panel">
          <div className="hint season-note">
            Each cell is one month. Color marks the inferred season; the label inside each
            cell is that month's dominant category.
          </div>
          <div className="season-ribbon">
            {data.months.map((month) => (
              <MonthCell key={month.ym} month={month} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Phase cards</h2>
        <div className="season-card-grid">
          {data.seasons.map((season) => (
            <SeasonCard key={season.id} season={season} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Breakpoint shifts</h2>
        <div className="panel">
          <table className="turn-table">
            <thead>
              <tr>
                <th>Start</th>
                <th>Transition</th>
                <th>Largest category shifts</th>
              </tr>
            </thead>
            <tbody>
              {data.breakpoints.map((breakpoint) => (
                <BreakpointRow key={breakpoint.ym} breakpoint={breakpoint} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.generated_at)} from monthly{" "}
        <code>seg_segment_categories</code>. Method: dynamic programming over contiguous
        segments, minimizing within-season category-mixture variance.
      </p>
    </div>
  );
}

function MonthCell({ month }: { month: SeasonMonth }) {
  return (
    <div
      className={`season-cell season-color-${month.season_id % 6}`}
      title={`${month.ym}: ${fmtInt(month.total)} segments, dominant ${month.dominant_category}`}
    >
      <span>{month.ym.slice(2)}</span>
      <strong>{compactCategory(month.dominant_category)}</strong>
    </div>
  );
}

function SeasonCard({ season }: { season: Season }) {
  return (
    <article className={`panel season-card season-border-${season.id % 6}`}>
      <div className="season-card-head">
        <div>
          <div className="season-title">Season {season.id + 1}</div>
          <div className="hint">{rangeLabel(season)} · {fmtInt(season.n_months)} months</div>
          <EvidenceLink
            evidence={{
              label: "Open season in Browse",
              from: `${season.start_ym}-01`,
              to: monthEndYmd(season.end_ym),
              note: rangeLabel(season),
            }}
          />
        </div>
        <div className="turn-score">{fmtInt(season.total_segments)}</div>
      </div>

      <div className="turn-block">
        <div className="turn-block-title">Category mix</div>
        <div className="turn-category-list">
          {season.categories.slice(0, 5).map((category) => (
            <SeasonCategoryBar key={category.category} category={category} />
          ))}
        </div>
      </div>

      <div className="turn-block">
        <div className="turn-block-title">Topic gravity</div>
        <div className="topic-chip-row">
          {season.topics.map((topic) => (
            <SeasonTopicChip key={topic.topic_id} topic={topic} />
          ))}
        </div>
      </div>

      <div className="turn-block">
        <div className="turn-block-title">Largest segments</div>
        <div className="segment-teaser-list">
          {season.segments.map((segment) => (
            <SeasonSegmentTeaser key={segment.id} segment={segment} />
          ))}
        </div>
      </div>
    </article>
  );
}

function SeasonCategoryBar({ category }: { category: SeasonCategory }) {
  const lift = category.delta_from_previous;
  return (
    <div className="turn-category-row">
      <div className="turn-category-meta">
        <span>{category.category}</span>
        <span>{formatPct(category.share)}</span>
      </div>
      <div className="turn-delta-track">
        <div className="season-mix-bar" style={{ width: `${Math.max(2, category.share * 100)}%` }} />
      </div>
      <div className="hint">
        {lift == null ? "first season baseline" : `${signedPct(lift)} vs previous comparable window`}
      </div>
    </div>
  );
}

function SeasonTopicChip({ topic }: { topic: SeasonTopic }) {
  return (
    <span className="topic-chip">
      {topic.label ?? topic.top_words.slice(0, 3).join(" / ")}
      <span>{fmtInt(topic.n)}</span>
    </span>
  );
}

function SeasonSegmentTeaser({ segment }: { segment: SeasonSegment }) {
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
          label: "Open segment day",
          date: bucket(segment.start_ts, "ymd"),
          note: segment.topic_label ?? segment.category,
        }}
      />
    </div>
  );
}

function BreakpointRow({ breakpoint }: { breakpoint: SeasonBreakpoint }) {
  return (
    <tr>
      <td>{breakpoint.ym}</td>
      <td>
        Season {breakpoint.from_season_id + 1} to {breakpoint.to_season_id + 1}
      </td>
      <td>
        <div className="breakpoint-shifts">
          {breakpoint.shifts.map((shift) => (
            <span key={shift.category}>
              {shift.category} {signedPct(shift.delta_from_previous ?? 0)}
            </span>
          ))}
        </div>
      </td>
    </tr>
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

function rangeLabel(season: Season) {
  return `${season.start_ym} to ${season.end_ym}`;
}

function compactCategory(category: string) {
  return category.replace(/_/g, " ").split(" ").slice(0, 2).join(" ");
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function signedPct(value: number) {
  return `${value >= 0 ? "+" : ""}${formatPct(value)}`;
}

function monthEndYmd(ym: string) {
  const [year, month] = ym.split("-").map(Number);
  const end = new Date(Date.UTC(year, month, 0));
  return end.toISOString().slice(0, 10);
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
