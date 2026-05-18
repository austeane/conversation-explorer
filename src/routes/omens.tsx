import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getOmens,
  type OmenEvent,
  type OmenKind,
  type OmenMonth,
  type OmenSignal,
  type OmenSignalGroup,
} from "~/server/omen-queries";

export const Route = createFileRoute("/omens")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getOmens({ data: deps }),
  component: OmensPage,
});

const KIND_LABELS: Record<OmenKind, string> = {
  surge: "Surge",
  lull: "Quiet",
  storm: "Storm",
  repair: "Repair",
};

function OmensPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxMonthCount = Math.max(
    ...data.months.map((month) => Math.max(month.surge, month.lull, month.storm, month.repair)),
    1,
  );

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Precursor analysis</div>
        <PageTitleRow activePath="/omens" />
        <p className="page-lede">
          A retrospective early-warning map: the 72 hours before volume surges,
          quiet drop-offs, strain-heavy weeks, and repair-heavy weeks. It is not a
          prediction engine; it asks what the conversation tended to sound like
          just before its weather changed.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: data.overview.inflection_windows,
            version: "omens-precursor-v1",
            caveats: [
              "Small event counts can make precursor phrases unstable.",
              "Neutral windows are sampled rather than era-matched.",
            ],
          }}
          confidence="low"
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} messages only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Inflection windows" value={fmtInt(data.overview.inflection_windows)} note={`${fmtInt(data.overview.days_analyzed)} active days scanned`} />
        <Stat label="Surges / quiet" value={`${data.overview.surge_events} / ${data.overview.lull_events}`} note="seven-day volume turns" />
        <Stat label="Storm / repair" value={`${data.overview.storm_events} / ${data.overview.repair_events}`} note="affective turns" />
        <Stat label="Strongest signal" value={data.overview.strongest_signal} note={data.overview.strongest_signal_kind ? KIND_LABELS[data.overview.strongest_signal_kind] : "n/a"} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Inflection strip</h2>
        <div className="panel">
          <div className="hint omen-note">
            Each column is a month with at least one detected hinge. Bars show how many
            selected hinge days fell into each class; the pin marks the strongest score
            found in that month.
          </div>
          <div className="omen-strip-scroll">
            <div className="omen-strip-frame">
              <div className="omen-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(9px, 1fr))` }}>
                {data.months.map((month) => (
                  <OmenMonthColumn key={month.ym} month={month} maxCount={maxMonthCount} />
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
        <h2><span className="num">02</span> Language before the turn</h2>
        <div className="omen-signal-grid">
          {data.signal_groups.map((group) => (
            <SignalGroup key={group.kind} group={group} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Hinge ledger</h2>
        <div className="omen-event-grid">
          {data.top_events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real
        messages. Method: seven-day before/after windows, 72-hour precursor text, smoothed
        log-odds against neutral active days, and lexicon rates for strain and repair.
      </p>
    </div>
  );
}

function OmenMonthColumn({ month, maxCount }: { month: OmenMonth; maxCount: number }) {
  const maxScore = Math.max(1, Math.min(month.max_score, 8));
  return (
    <div className="omen-column" title={`${month.ym}: ${month.surge} surge, ${month.lull} quiet, ${month.storm} storm, ${month.repair} repair`}>
      <div className="omen-stack">
        <span className="omen-bar surge" style={{ height: `${barHeight(month.surge, maxCount)}%` }} />
        <span className="omen-bar lull" style={{ height: `${barHeight(month.lull, maxCount)}%` }} />
        <span className="omen-bar storm" style={{ height: `${barHeight(month.storm, maxCount)}%` }} />
        <span className="omen-bar repair" style={{ height: `${barHeight(month.repair, maxCount)}%` }} />
      </div>
      <span className="omen-score-pin" style={{ bottom: `${Math.max(5, (maxScore / 8) * 82)}%` }} />
    </div>
  );
}

function SignalGroup({ group }: { group: OmenSignalGroup }) {
  return (
    <article className={`panel omen-signal-group ${group.kind}`}>
      <div className="omen-group-head">
        <div>
          <div className="turn-block-title">{group.label}</div>
          <p>{group.description}</p>
        </div>
        <span>{group.signals.length}</span>
      </div>
      <div className="omen-signal-list">
        {group.signals.map((signal) => (
          <SignalRow key={`${group.kind}-${signal.phrase}`} signal={signal} />
        ))}
      </div>
    </article>
  );
}

function SignalRow({ signal }: { signal: OmenSignal }) {
  return (
    <div className="omen-signal-row">
      <div className="omen-signal-main">
        <span className="omen-phrase">&quot;{signal.phrase}&quot;</span>
        <span className="omen-lift">{signal.lift.toFixed(1)}x log lift</span>
      </div>
      <div className="omen-signal-meta">
        <span>{signal.event_windows}/{signal.event_total} hinge windows</span>
        <span>{signal.neutral_windows}/{signal.neutral_total} neutral</span>
      </div>
      {signal.examples.slice(0, 1).map((example) => (
        <div className="omen-signal-example" key={`${signal.phrase}-${example.ts}`}>
          <span>{example.sender} before {example.event_ymd}</span>
          <p>{example.text}</p>
          <EvidenceLink
            evidence={{
              label: "Browse precursor",
              from: example.ymd,
              to: example.ymd,
              sender: senderParam(example.sender),
              q: signal.phrase,
              note: signal.phrase,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function EventCard({ event }: { event: OmenEvent }) {
  return (
    <article className={`panel omen-event-card ${event.kind}`}>
      <div className="omen-event-head">
        <div>
          <div className="omen-date">{fmtDate(Date.parse(`${event.ymd}T12:00:00Z`) / 1000)}</div>
          <div className="omen-event-score">{event.score.toFixed(2)}</div>
        </div>
        <span>{event.label}</span>
      </div>
      <div className="omen-shift">
        <div>
          <span>past 7d</span>
          <strong>{fmtInt(event.past_messages)}</strong>
        </div>
        <div>
          <span>next 7d</span>
          <strong>{fmtInt(event.future_messages)}</strong>
        </div>
        <div>
          <span>{event.rate_label}</span>
          <strong>{formatShift(event)}</strong>
        </div>
      </div>
      <div className="omen-example-columns">
        <ExampleColumn title="Before" examples={event.before_examples} />
        <ExampleColumn title="After" examples={event.after_examples} />
      </div>
    </article>
  );
}

function ExampleColumn({ title, examples }: { title: string; examples: OmenEvent["before_examples"] }) {
  return (
    <div className="omen-example-column">
      <strong>{title}</strong>
      {examples.map((example) => (
        <div className="omen-event-example" key={`${title}-${example.ts}-${example.sender}-${example.text.slice(0, 24)}`}>
          <span>{example.sender} · {fmtDate(example.ts, { withTime: true })}</span>
          <p>{example.text}</p>
          <EvidenceLink
            evidence={{
              label: `Browse ${title.toLowerCase()}`,
              date: example.ymd,
              sender: senderParam(example.sender),
              note: `${example.sender} ${title.toLowerCase()}`,
            }}
          />
        </div>
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

function barHeight(count: number, maxCount: number) {
  return count === 0 ? 0 : Math.max(12, (count / maxCount) * 100);
}

function formatShift(event: OmenEvent) {
  if (event.kind === "surge" || event.kind === "lull") {
    const sign = event.delta_messages > 0 ? "+" : "";
    return `${sign}${fmtInt(event.delta_messages)}`;
  }
  return `${event.past_rate.toFixed(1)} -> ${event.future_rate.toFixed(1)}`;
}

function senderParam(sender: "Me" | "Them") {
  return sender === "Me" ? "me" : "them";
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
