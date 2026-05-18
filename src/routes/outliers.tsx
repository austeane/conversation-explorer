import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getOutliers,
  type FeatureLeader,
  type OutlierDay,
  type OutlierFeature,
  type OutlierMonth,
  type QuietDay,
} from "~/server/outlier-queries";

export const Route = createFileRoute("/outliers")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getOutliers({ data: deps }),
  component: OutliersPage,
});

function OutliersPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxMonthScore = Math.max(...data.months.map((month) => month.max_score), 1);
  const maxOutlierDays = Math.max(...data.months.map((month) => month.outlier_days), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Robust anomaly scan</div>
        <PageTitleRow activePath="/outliers" />
        <p className="page-lede">
          A daily outlier detector for the conversation. Each active day is scored with robust
          z-scores across volume, word density, tempo, affect, strain, repair, attachments,
          semantic departure, topic spread, and sender skew.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.ranked_days,
            version: `outliers-${String(data.overview.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Scores are robust anomaly ranks, not importance or causality.",
              "Sparse days only rank after the support gate.",
              "Semantic departure uses the offline UMAP embedding space.",
            ],
          }}
          confidence="medium"
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat
          label="Active days"
          value={fmtInt(data.overview.active_days)}
          note={`${fmtInt(data.overview.ranked_days)} ranked, ${fmtInt(data.overview.messages)} messages`}
        />
        <Stat
          label="Outlier days"
          value={fmtInt(data.overview.outlier_days)}
          note={`score >= ${data.overview.threshold.toFixed(1)}`}
        />
        <Stat label="Top day" value={data.overview.top_day} note={scoreLabel(data.overview.top_score)} />
        <Stat label="Top signal" value={data.overview.strongest_signal} note="strongest feature" />
        <Stat label="Quiet days" value={fmtInt(data.overview.quiet_days)} note="low-volume active days" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Eventfulness skyline</h2>
        <div className="panel">
          <div className="hint outlier-note">
            Each month shows the most unusual active day. Dark ticks count how many days crossed
            the outlier threshold.
          </div>
          <div className="outlier-strip-scroll">
            <div className="outlier-strip-frame">
              <div className="outlier-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(8px, 1fr))` }}>
                {data.months.map((month) => (
                  <OutlierMonthColumn
                    key={month.ym}
                    month={month}
                    maxScore={maxMonthScore}
                    maxOutlierDays={maxOutlierDays}
                  />
                ))}
              </div>
              <div className="restart-axis">
                <span>{data.months[0]?.ym}</span>
                <span>{data.months[data.months.length - 1]?.ym}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Ranked event days</h2>
        <div className="outlier-day-grid">
          {data.days.map((day) => (
            <OutlierDayCard key={day.ymd} day={day} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Feature leaders</h2>
        <div className="outlier-leader-grid">
          {data.feature_leaders.map((leader) => (
            <FeatureLeaderCard key={`${leader.feature_key}-${leader.day.ymd}`} leader={leader} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Quiet days</h2>
        <div className="panel">
          <div className="hint outlier-note">
            These are active days on the low side of the archive's robust daily baseline. They are not
            failures or absences, just useful counterpoints to the spike-led event list.
          </div>
          <div className="outlier-quiet-grid">
            {data.quiet_days.map((day) => (
              <QuietDayCard key={day.ymd} day={day} />
            ))}
          </div>
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)}. Method:
        smoothed rates and robust z-scores over active-day features, ranked after a minimum
        support gate of {data.overview.min_ranked_messages} messages or one long-text day.
        Semantic departure uses a rolling 30-active-day UMAP centroid.
      </p>
    </div>
  );
}

function QuietDayCard({ day }: { day: QuietDay }) {
  return (
    <article className="outlier-quiet-card">
      <div>
        <strong>{day.ymd}</strong>
        <span>quiet score {scoreLabel(day.quiet_score)}</span>
      </div>
      <div className="outlier-metrics">
        <span>{fmtInt(day.messages)} messages</span>
        <span>{fmtInt(day.words)} words</span>
        <span>baseline {fmtInt(day.expected_messages)}</span>
        <span>Me {formatPct(day.me_share)}</span>
      </div>
      <EvidenceLink
        evidence={{
          label: "Open day in Browse",
          date: day.ymd,
          note: "quiet active day",
        }}
      />
      {day.examples.length > 0 ? (
        <p>{day.examples[0].text}</p>
      ) : (
        <p>No text preview available.</p>
      )}
    </article>
  );
}

function OutlierMonthColumn({ month, maxScore, maxOutlierDays }: { month: OutlierMonth; maxScore: number; maxOutlierDays: number }) {
  const height = Math.max(3, (month.max_score / maxScore) * 100);
  const tickHeight = month.outlier_days ? Math.max(8, (month.outlier_days / maxOutlierDays) * 70) : 0;
  return (
    <div className="outlier-column" title={`${month.ym}: top ${month.top_day}, score ${scoreLabel(month.max_score)}`}>
      <div className="outlier-score-bar" style={{ height: `${height}%` }} />
      <div className="outlier-count-tick" style={{ height: `${tickHeight}%` }} />
    </div>
  );
}

function OutlierDayCard({ day }: { day: OutlierDay }) {
  return (
    <article className="panel outlier-day-card">
      <div className="outlier-card-head">
        <div>
          <div className="turn-block-title">{formatYmdLabel(day.ymd)}</div>
          <div className="outlier-score">{scoreLabel(day.score)}</div>
        </div>
        <div className="outlier-date">{day.ymd}</div>
      </div>
      <div className="outlier-metrics">
        <span>{fmtInt(day.messages)} messages</span>
        <span>{fmtInt(day.words)} words</span>
        <span>{fmtDuration(day.end_ts - day.start_ts)}</span>
        <span>Me {formatPct(day.me_share)}</span>
        {day.attachments ? <span>{fmtInt(day.attachments)} attachments</span> : null}
      </div>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open day in Browse",
            date: day.ymd,
            note: `${fmtInt(day.messages)} messages on this eventful day`,
          }}
        />
      </div>
      <div className="outlier-features">
        {day.features.map((feature) => (
          <FeaturePill key={`${day.ymd}-${feature.key}`} feature={feature} />
        ))}
      </div>
      <div className="outlier-category-row">
        {day.categories.map((category) => (
          <span key={`${day.ymd}-${category.category}`}>{category.category.replace(/_/g, " ")} {formatPct(category.share)}</span>
        ))}
      </div>
      <div className="outlier-examples">
        {day.examples.map((example) => (
          <div key={example.id} className={example.sender === "Me" ? "outlier-example me" : "outlier-example them"}>
            <span>{example.sender} / {fmtDate(example.ts, { withTime: true })}</span>
            <p>{example.text}</p>
            {example.kinds.length > 0 && <b>{example.kinds.join(" / ")}</b>}
          </div>
        ))}
      </div>
    </article>
  );
}

function FeatureLeaderCard({ leader }: { leader: FeatureLeader }) {
  const leaderFeature = leader.day.features.find((feature) => feature.key === leader.feature_key);
  const featurePills = leaderFeature
    ? [leaderFeature, ...leader.day.features.filter((feature) => feature.key !== leader.feature_key)].slice(0, 3)
    : leader.day.features.slice(0, 3);

  return (
    <article className="panel outlier-leader-card">
      <div className="turn-block-title">{leader.feature}</div>
      <div className="outlier-leader-date">{leader.day.ymd}</div>
      <div className="outlier-metrics">
        <span>{scoreLabel(leader.day.score)} total score</span>
        <span>{fmtInt(leader.day.messages)} messages</span>
      </div>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open day in Browse",
            date: leader.day.ymd,
            note: `${leader.feature} leader`,
          }}
        />
      </div>
      <div className="outlier-features">
        {featurePills.map((feature) => (
          <FeaturePill key={`${leader.feature}-${feature.key}`} feature={feature} />
        ))}
      </div>
    </article>
  );
}

function FeaturePill({ feature }: { feature: OutlierFeature }) {
  return (
    <span className="outlier-feature-pill">
      <strong>{feature.label}</strong>
      <em>z {feature.z.toFixed(1)}</em>
    </span>
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

function scoreLabel(value: number) {
  return value.toFixed(2);
}

function formatYmdLabel(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  return `${MONTH_NAMES[month - 1] ?? ""} ${day}, ${year}`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function formatPct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
