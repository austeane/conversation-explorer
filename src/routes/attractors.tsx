import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getAttractors,
  type Attractor,
  type AttractorEscape,
  type AttractorFeature,
  type AttractorTransition,
  type AttractorWeek,
} from "~/server/attractor-queries";

export const Route = createFileRoute("/attractors")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getAttractors({ data: deps }),
  component: AttractorsPage,
});

function AttractorsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const sender = activeSender(search.sender);
  const path = data.path_weeks.map((week, index) => `${index ? "L" : "M"} ${week.x.toFixed(2)} ${week.y.toFixed(2)}`).join(" ");

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">State-space analysis</div>
        <PageTitleRow activePath="/attractors" />
        <p className="page-lede">
          Weekly windows become state vectors across intensity, reciprocity, tempo, warmth,
          strain, repair, play, practical logistics, and shared objects. The route clusters
          those weeks into recurrent basins and traces how the conversation moves between them.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.active_weeks,
            version: "weekly-attractors-kmeans-v1",
            caveats: [
              "Active weeks require at least 12 real messages.",
              "Transition lift is descriptive and does not imply causal movement.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{sender ? `, ${sender} only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Active weeks" value={fmtInt(data.overview.active_weeks)} note="12+ real messages" />
        <Stat label="Attractors" value={fmtInt(data.overview.attractors)} note="deterministic k-means" />
        <Stat label="Basin stability" value={formatPct(data.overview.stability_rate)} note="same state next week" />
        <Stat label="Largest escape" value={data.overview.largest_escape} note="biggest week-to-week jump" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> State-space path</h2>
        <div className="panel attractor-map-panel">
          <div className="hint attractor-note">
            Each point is one active week. Left-to-right is colder to warmer; bottom-to-top is
            lower to higher conversational energy. Point size follows message volume.
          </div>
          <div className="attractor-map-wrap">
            <svg className="attractor-map" viewBox="0 0 100 76" role="img" aria-label="Weekly conversation state-space path">
              <line className="attractor-axis" x1="5" y1="68" x2="95" y2="68" />
              <line className="attractor-axis" x1="50" y1="8" x2="50" y2="70" />
              <path className="attractor-path" d={path} />
              {data.weeks.map((week) => (
                <circle
                  key={week.key}
                  className={`attractor-dot attractor-color-${week.cluster_id % 6}`}
                  cx={week.x}
                  cy={week.y}
                  r={week.radius}
                />
              ))}
            </svg>
          </div>
          <div className="attractor-legend">
            {data.attractors.map((attractor) => (
              <span key={attractor.id}>
                <i className={`attractor-swatch attractor-color-${attractor.id % 6}`} />
                {attractor.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Attractor basins</h2>
        <div className="attractor-grid">
          {data.attractors.map((attractor) => (
            <AttractorCard key={attractor.id} attractor={attractor} sender={sender} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Escapes and grooves</h2>
        <div className="row row-2">
          <div className="attractor-list">
            {data.escapes.map((escape) => (
              <EscapeCard key={escape.key} escape={escape} sender={sender} />
            ))}
          </div>
          <div className="attractor-list">
            {data.transitions.map((transition) => (
              <TransitionCard key={transition.key} transition={transition} />
            ))}
          </div>
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.overview.generated_at)} from scoped real
        messages. Method: Monday-start active weeks, lexicon state vectors, z-scored
        deterministic k-means, transition lift, and week-to-week vector distance.
      </p>
    </div>
  );
}

function AttractorCard({ attractor, sender }: { attractor: Attractor; sender?: "me" | "them" }) {
  return (
    <article className="panel attractor-card">
      <div className="attractor-card-head">
        <div>
          <div className="turn-block-title">{attractor.label}</div>
          <p>{fmtInt(attractor.weeks)} weeks · {formatPct(attractor.share)} of active weeks</p>
        </div>
        <div className="attractor-count">{fmtInt(attractor.messages)}</div>
      </div>
      <div className="attractor-metrics">
        <span>{fmtInt(attractor.avg_messages)} msgs/wk</span>
        <span>{formatPct(attractor.avg_me_share)} Me share</span>
      </div>
      <div className="attractor-feature-list">
        {attractor.features.map((feature) => (
          <FeatureBar key={feature.key} feature={feature} />
        ))}
      </div>
      <div className="attractor-words">
        {attractor.signature_words.map((word) => (
          <span key={word}>{word}</span>
        ))}
      </div>
      <div className="attractor-weeks">
        {attractor.representative_weeks.map((week) => (
          <div key={week.key}>
            <span>{fmtDate(week.start_ts)} · {fmtInt(week.messages)} msgs</span>
            <EvidenceLink
              evidence={{
                label: "Open week in Browse",
                from: bucket(week.start_ts, "ymd"),
                to: bucket(week.end_ts - 1, "ymd"),
                sender,
                note: `${attractor.label} representative week`,
              }}
            />
          </div>
        ))}
      </div>
    </article>
  );
}

function FeatureBar({ feature }: { feature: AttractorFeature }) {
  return (
    <div className="attractor-feature">
      <span>{feature.label}</span>
      <div>
        <i style={{ width: `${Math.max(4, feature.value * 100)}%` }} />
      </div>
      <strong>{formatPct(feature.value)}</strong>
    </div>
  );
}

function EscapeCard({ escape, sender }: { escape: AttractorEscape; sender?: "me" | "them" }) {
  return (
    <article className="panel attractor-event-card">
      <div className="attractor-event-head">
        <div>
          <span>{fmtDate(escape.start_ts)}</span>
          <strong>{escape.from_label} -&gt; {escape.to_label}</strong>
        </div>
        <b>{escape.distance.toFixed(1)}</b>
      </div>
      <div className="attractor-metrics">
        <span>{fmtInt(escape.messages)} msgs</span>
        {escape.feature_changes.map((change) => (
          <span key={change.key}>{change.label} {formatDelta(change.delta)}</span>
        ))}
      </div>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open escape week",
            date: bucket(escape.start_ts, "ymd"),
            sender,
            note: `${escape.from_label} to ${escape.to_label}`,
          }}
        />
      </div>
    </article>
  );
}

function TransitionCard({ transition }: { transition: AttractorTransition }) {
  return (
    <article className="panel attractor-event-card">
      <div className="attractor-event-head">
        <div>
          <span>{fmtInt(transition.count)} transitions</span>
          <strong>{transition.from_label} -&gt; {transition.to_label}</strong>
        </div>
        <b>{transition.lift.toFixed(1)}x</b>
      </div>
      <div className="attractor-metrics">
        <span>{formatPct(transition.rate)} of exits</span>
        <span>lift over baseline</span>
      </div>
    </article>
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

function formatDelta(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${Math.round(value * 100)}pt`;
}

function activeSender(value: unknown) {
  return value === "me" || value === "them" ? value : undefined;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
