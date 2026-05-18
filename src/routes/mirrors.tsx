import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getMirrors,
  type MirrorDirection,
  type MirrorExample,
  type MirrorFeature,
  type MirrorMonth,
} from "~/server/mirror-queries";

export const Route = createFileRoute("/mirrors")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getMirrors({ data: deps }),
  component: MirrorsPage,
});

function MirrorsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const sourceFilter = search.sender === "me" || search.sender === "them" ? search.sender : "both";
  const isOneSided = sourceFilter !== "both";
  const visibleFeatureTests = isOneSided ? data.features.length : data.overview.feature_tests;
  const maxPairs = Math.max(...data.months.map((month) => month.pairs), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Reply mirroring</div>
        <PageTitleRow activePath="/mirrors" />
        <p className="page-lede">
          Who adapts to whom in the next turn. This view compares each reply with the
          source turn across length, questions, warmth, humor, strain, repair,
          planning, emoji, and sent objects, using each person&apos;s own baseline.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: data.overview.reply_pairs,
            version: "mirror-adaptation-v1",
            caveats: [
              "High-signal thresholds are per sender and per scoped archive window.",
              "Sender filters apply to source turns while preserving opposite-person replies.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} source turns only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Reply pairs" value={fmtInt(data.overview.reply_pairs)} note={`${fmtInt(data.overview.turns)} turns`} />
        <Stat label="Stronger mirror" value={data.overview.stronger_direction} note={`${fmtInt(visibleFeatureTests)} directional tests`} />
        <Stat label="Top mirror" value={data.overview.strongest_mirror} note="largest above-baseline reply echo" />
        <Stat
          label="Biggest asymmetry"
          value={isOneSided ? "One direction" : data.overview.strongest_asymmetry}
          note={isOneSided ? "sender filter hides the comparison" : `${formatPct(data.overview.strongest_asymmetry_gap)} between directions`}
        />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly synchrony</h2>
        <div className="panel mirror-month-panel">
          <div className="hint">
            Bars show paired reply volume. Overlays show the share of high source signals mirrored
            in the next turn: blue for Me -&gt; Them, red for Them -&gt; Me.
          </div>
          <div className="mirror-month-scroll">
            <div className="mirror-month-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(10px, 1fr))` }}>
              {data.months.map((month) => (
                <MonthColumn key={month.ym} month={month} maxPairs={maxPairs} />
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
        <h2><span className="num">02</span> Mirror fingerprint</h2>
        <div className="mirror-feature-grid">
          {data.features.map((feature) => (
            <FeatureCard key={feature.key} feature={feature} sourceFilter={sourceFilter} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Mirrored evidence</h2>
        <div className="mirror-example-grid">
          {data.examples.map((example) => (
            <ExampleCard key={`${example.feature}-${example.source_ts}-${example.reply_ts}`} example={example} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from{" "}
        {fmtInt(data.overview.real_messages)} real messages. Method: 20-minute same-sender
        turn collapse, adjacent 24-hour reply pairs, per-sender high-signal thresholds, and
        above-baseline same-feature reply rates.
      </p>
    </div>
  );
}

function MonthColumn({ month, maxPairs }: { month: MirrorMonth; maxPairs: number }) {
  const height = Math.max(4, (month.pairs / maxPairs) * 100);
  const meHeight = month.me_to_them_score > 0 ? Math.max(3, month.me_to_them_score * 100) : 0;
  const themHeight = month.them_to_me_score > 0 ? Math.max(3, month.them_to_me_score * 100) : 0;
  return (
    <div
      className="mirror-month-column"
      title={`${month.ym}: ${fmtInt(month.pairs)} pairs, Me->Them ${formatPct(month.me_to_them_score)}, Them->Me ${formatPct(month.them_to_me_score)}`}
    >
      <span className="mirror-volume" style={{ height: `${height}%` }} />
      <span className="mirror-me" style={{ height: `${meHeight}%` }} />
      <span className="mirror-them" style={{ height: `${themHeight}%` }} />
    </div>
  );
}

function FeatureCard({ feature, sourceFilter }: { feature: MirrorFeature; sourceFilter: "me" | "them" | "both" }) {
  const directions = sourceFilter === "me"
    ? [feature.me_to_them]
    : sourceFilter === "them"
      ? [feature.them_to_me]
      : [feature.me_to_them, feature.them_to_me];
  const lead = directions.slice().sort((a, b) => b.delta - a.delta)[0] ?? feature.me_to_them;
  return (
    <article className="panel mirror-feature-card">
      <div className="mirror-feature-head">
        <div>
          <div className="turn-block-title">{feature.label}</div>
          <p>{feature.description}</p>
        </div>
        <strong>{formatSignedPct(lead.delta)}</strong>
      </div>
      {directions.map((direction) => (
        <DirectionRow key={direction.key} direction={direction} />
      ))}
      {sourceFilter === "both" && (
        <div className="mirror-asymmetry">
          <span>asymmetry</span>
          <b>{formatPct(feature.asymmetry)}</b>
        </div>
      )}
    </article>
  );
}

function DirectionRow({ direction }: { direction: MirrorDirection }) {
  const conditionedWidth = Math.max(2, Math.min(100, direction.conditioned_rate * 100));
  const baseWidth = Math.max(2, Math.min(100, direction.base_rate * 100));
  return (
    <div className="mirror-direction-row">
      <div className="mirror-direction-meta">
        <span>{direction.source_sender} -&gt; {direction.reply_sender}</span>
        <strong>{formatPct(direction.conditioned_rate)}</strong>
      </div>
      <div className="mirror-bars">
        <i className="conditioned" style={{ width: `${conditionedWidth}%` }} />
        <i className="base" style={{ width: `${baseWidth}%` }} />
      </div>
      <div className="mirror-direction-foot">
        <span>{fmtInt(direction.source_high_pairs)} high-source pairs</span>
        <span>{direction.lift.toFixed(2)}x lift</span>
        <span>{formatSignedPct(direction.delta)}</span>
        <span>{fmtDuration(direction.median_reply_seconds)}</span>
      </div>
    </div>
  );
}

function ExampleCard({ example }: { example: MirrorExample }) {
  return (
    <article className="panel mirror-example-card">
      <div className="mirror-example-head">
        <div>
          <span>{example.feature}</span>
          <strong>{example.source_sender} -&gt; {example.reply_sender}</strong>
        </div>
        <b>{example.lift.toFixed(2)}x</b>
      </div>
      <div className="mirror-example-meta">
        <span>{example.source_value}</span>
        <span>{example.reply_value}</span>
        <span>{fmtDuration(example.reply_seconds)} later</span>
      </div>
      <div className="mirror-pair">
        <div>
          <strong>{example.source_sender} · {fmtDate(example.source_ts, { withTime: true })}</strong>
          <p>{example.source_text}</p>
          <EvidenceLink
            evidence={{
              label: "Browse source",
              date: example.source_ymd,
              sender: senderParam(example.source_sender),
              note: `${example.source_sender} ${example.feature}`,
            }}
          />
        </div>
        <div>
          <strong>{example.reply_sender} · {fmtDate(example.reply_ts, { withTime: true })}</strong>
          <p>{example.reply_text}</p>
          <EvidenceLink
            evidence={{
              label: "Browse reply",
              date: example.reply_ymd,
              sender: senderParam(example.reply_sender),
              note: `${example.reply_sender} ${example.feature}`,
            }}
          />
        </div>
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

function formatSignedPct(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPct(value)}`;
}

function senderParam(sender: MirrorExample["source_sender"]) {
  return sender === "Me" ? "me" as const : "them" as const;
}

function formatGeneratedAt(value: string) {
  return value.slice(0, 19).replace("T", " ");
}
