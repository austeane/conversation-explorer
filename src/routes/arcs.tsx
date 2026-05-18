import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getArcs,
  type ArcCluster,
  type ArcDayShape,
  type ArcMonth,
  type ArcTransition,
  type ArcWindowExample,
} from "~/server/arc-queries";

export const Route = createFileRoute("/arcs")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getArcs({ data: deps }),
  component: ArcsPage,
});

function ArcsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const sender = activeSender(search.sender);
  const labelOrder = data.clusters.map((cluster) => cluster.label);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Temporal motifs</div>
        <PageTitleRow activePath="/arcs" />
        <p className="page-lede">
          Five-day shapes clustered by volume, reciprocity, warmth, strain, repair,
          planning, play, and late-night texture. This view treats the thread as a
          sequence of recurring mini-stories rather than isolated messages or days.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.windows,
            version: "arc-kmeans-v1",
            caveats: [
              "Overlapping five-day windows are not independent samples.",
              "Cluster labels summarize standardized vectors, not fixed narrative categories.",
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
        <Stat label="Arc windows" value={fmtInt(data.overview.windows)} note={`${fmtInt(data.overview.active_days)} active days`} />
        <Stat label="Current arc" value={data.overview.current_arc} note="nearest latest 5-day shape" />
        <Stat label="Dominant arc" value={data.overview.dominant_arc} note={`${data.overview.arcs} archetypes`} />
        <Stat label="Strongest path" value={data.overview.strongest_transition} note={`rare arc: ${data.overview.rare_arc}`} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Arc archetypes</h2>
        <div className="arc-cluster-grid">
          {data.clusters.map((cluster, index) => (
            <ClusterCard key={cluster.id} cluster={cluster} colorIndex={index} sender={sender} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Month-by-month pulse</h2>
        <div className="panel arc-month-panel">
          <div className="hint">
            Each month shows the three most common five-day arc types ending in that month.
          </div>
          <div className="arc-month-scroll">
            <div className="arc-month-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(18px, 1fr))` }}>
              {data.months.map((month) => (
                <MonthColumn key={month.ym} month={month} labelOrder={labelOrder} />
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
        <h2><span className="num">03</span> Arc transitions</h2>
        <div className="arc-transition-grid">
          {data.transitions.map((transition) => (
            <TransitionCard key={`${transition.from}-${transition.to}-${transition.example_start}`} transition={transition} sender={sender} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Representative windows</h2>
        <div className="arc-example-grid">
          {data.examples.map((example) => (
            <ExampleCard key={example.id} example={example} sender={sender} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.overview.generated_at)} from scoped real
        messages. Method: sliding five-day windows, smoothed lexical affect and activity
        rates, standardized temporal vectors, deterministic k-means, nearest-centroid
        representative windows, and lifted transitions between adjacent window labels.
      </p>
    </div>
  );
}

function ClusterCard({ cluster, colorIndex, sender }: { cluster: ArcCluster; colorIndex: number; sender?: "me" | "them" }) {
  return (
    <article className={`panel arc-cluster-card arc-color-${colorIndex % 7}`}>
      <div className="arc-card-head">
        <div>
          <div className="turn-block-title">{cluster.label}</div>
          <p>{cluster.description}</p>
        </div>
        <strong>{formatPct(cluster.share)}</strong>
      </div>
      <ArcShape shape={cluster.shape} />
      <div className="arc-metrics">
        <Metric label="windows" value={fmtInt(cluster.windows)} />
        <Metric label="median msgs" value={fmtInt(cluster.median_messages)} />
        <Metric label="balance" value={formatPct(cluster.median_balance)} />
        <Metric label="warm" value={cluster.median_warmth.toFixed(1)} />
        <Metric label="strain" value={cluster.median_strain.toFixed(1)} />
        <Metric label="repair" value={cluster.median_repair.toFixed(1)} />
      </div>
      <div className="arc-signals">
        {cluster.signals.map((signal) => (
          <span key={`${cluster.id}-${signal}`}>{signal}</span>
        ))}
      </div>
      <div className="arc-mini-examples">
        {cluster.examples.map((example) => (
          <div key={example.id}>
            <strong>{example.start_ymd} - {example.end_ymd}</strong>
            <span>{fmtInt(example.messages)} msgs · score {example.score.toFixed(2)}</span>
            <EvidenceLink
              evidence={{
                label: "Open window",
                from: example.start_ymd,
                to: example.end_ymd,
                sender,
                note: cluster.label,
              }}
            />
          </div>
        ))}
      </div>
    </article>
  );
}

function ArcShape({ shape }: { shape: ArcDayShape[] }) {
  return (
    <div className="arc-shape" aria-hidden="true">
      {shape.map((day) => (
        <div className="arc-shape-day" key={day.day}>
          <i className="intensity" style={{ height: `${bar(day.intensity)}%` }} />
          <i className="warmth" style={{ height: `${bar(day.warmth)}%` }} />
          <i className="strain" style={{ height: `${bar(day.strain)}%` }} />
          <i className="repair" style={{ height: `${bar(day.repair)}%` }} />
          <i className="balance" style={{ height: `${bar(day.reciprocity)}%` }} />
        </div>
      ))}
    </div>
  );
}

function MonthColumn({ month, labelOrder }: { month: ArcMonth; labelOrder: string[] }) {
  return (
    <div className="arc-month-column" title={`${month.ym}: ${month.arcs.map((arc) => `${arc.label} ${formatPct(arc.share)}`).join(", ")}`}>
      {month.arcs.map((arc) => (
        <span
          key={`${month.ym}-${arc.label}`}
          className={`arc-month-slice arc-color-${Math.max(0, labelOrder.indexOf(arc.label)) % 7}`}
          style={{ height: `${Math.max(8, arc.share * 100)}%` }}
        />
      ))}
    </div>
  );
}

function TransitionCard({ transition, sender }: { transition: ArcTransition; sender?: "me" | "them" }) {
  return (
    <article className="panel arc-transition-card">
      <div className="arc-transition-path">
        <span>{transition.from}</span>
        <strong>{" -> "}</strong>
        <span>{transition.to}</span>
      </div>
      <div className="arc-transition-meta">
        <span>{fmtInt(transition.count)} transitions</span>
        <span>{transition.lift.toFixed(1)}x lift</span>
        <span>example {transition.example_start}</span>
      </div>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open example day",
            date: transition.example_start,
            sender,
            note: `${transition.from} to ${transition.to}`,
          }}
        />
      </div>
    </article>
  );
}

function ExampleCard({ example, sender }: { example: ArcWindowExample; sender?: "me" | "them" }) {
  return (
    <article className="panel arc-example-card">
      <div className="arc-example-head">
        <div>
          <span>{example.label}</span>
          <strong>{example.start_ymd} - {example.end_ymd}</strong>
        </div>
        <b>{example.score.toFixed(2)}</b>
      </div>
      <ArcShape shape={example.shape} />
      <div className="arc-example-meta">
        <span>{fmtInt(example.messages)} messages</span>
        <span>{example.warmth.toFixed(1)} warm / 100</span>
        <span>{example.strain.toFixed(1)} strain / 100</span>
        <span>{example.repair.toFixed(1)} repair / 100</span>
      </div>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open window in Browse",
            from: example.start_ymd,
            to: example.end_ymd,
            sender,
            note: `${example.label} representative window`,
          }}
        />
      </div>
      <div className="arc-message-list">
        {example.examples.map((message, index) => (
          <div key={`${example.id}-${message.ts}-${index}`}>
            <span>{message.sender} · {fmtDate(message.ts, { withTime: true })}</span>
            <p>{message.text}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
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
  if (value > 0 && value < 0.01) return "<1%";
  if (value > 0 && value < 0.1) return `${(value * 100).toFixed(1)}%`;
  return `${Math.round(value * 100)}%`;
}

function bar(value: number) {
  return Math.max(3, Math.min(100, value * 100));
}

function activeSender(value: unknown) {
  return value === "me" || value === "them" ? value : undefined;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
