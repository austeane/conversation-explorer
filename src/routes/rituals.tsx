import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { evidenceHref, EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getRituals,
  type DaypartRitual,
  type HourCell,
  type PhraseAnchor,
  type RestartAnchor,
  type RitualExample,
  type RitualPattern,
} from "~/server/ritual-queries";

export const Route = createFileRoute("/rituals")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getRituals({ data: deps }),
  component: RitualsPage,
});

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function RitualsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const strongestDaypart = [...data.dayparts].sort((a, b) => b.total - a.total)[0];

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Ritual cartography</div>
        <PageTitleRow activePath="/rituals" />
        <p className="page-lede">
          Recurring habits in the thread: the hours that hold the conversation, repeated
          love-and-logistics formulas, silence reopeners, and phrases that became shared
          infrastructure.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.real_messages,
            version: "ritual-patterns-v1",
            caveats: [
              "Named rituals use overlapping regexes.",
              "Silence reopener labels are phrase heuristics, not outcome models.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Real messages" value={fmtInt(data.overview.real_messages)} note={`${fmtInt(data.overview.active_days)} active days`} />
        <Stat label="Ritual hits" value={fmtInt(data.overview.ritual_hits)} note="messages matching named patterns" />
        <Stat label="Peak hour" value={formatHour(data.overview.peak_hour)} note={`${fmtInt(data.overview.peak_hour_messages)} messages`} />
        <Stat label="Top anchor" value={data.overview.top_phrase || "n/a"} note={`${fmtInt(data.overview.top_phrase_count)} appearances`} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Weekday-hour groove</h2>
        <div className="panel">
          <div className="hint ritual-note">
            Heat marks message density by Vancouver local time. This is the thread's habitual
            clock, independent of topic.
          </div>
          <HourHeatmap cells={data.hour_cells} />
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Daypart roles</h2>
        <div className="row row-2">
          <div className="panel">
            <div className="turn-block-title">Strongest daypart</div>
            {strongestDaypart ? (
              <div className="ritual-emphasis">
                <strong>{strongestDaypart.label}</strong>
                <span>{formatPct(strongestDaypart.share)} of real messages</span>
                <small>Peak inside it: {formatHour(strongestDaypart.peak_hour)}</small>
              </div>
            ) : null}
            <p className="hint ritual-note">
              Dayparts show whether the conversation's routine center is waking up, coordinating
              the day, unwinding, or closing down.
            </p>
          </div>
          <div className="panel">
            <div className="daypart-stack">
              {data.dayparts.map((part) => (
                <DaypartBar key={part.key} part={part} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Named rituals</h2>
        <div className="ritual-card-grid">
          {data.patterns.map((pattern) => (
            <PatternCard key={pattern.key} pattern={pattern} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Phrase anchors</h2>
        <div className="panel">
          <div className="hint ritual-note">
            Repeated two- and three-word phrases ranked by count, spread across days/months,
            and how much both people use them.
          </div>
          <div className="phrase-anchor-grid">
            {data.phrase_anchors.map((anchor) => (
              <PhraseAnchorRow key={anchor.phrase} anchor={anchor} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">05</span> Silence reopeners</h2>
        <div className="restart-grid">
          {data.restart_anchors.map((anchor) => (
            <RestartCard key={anchor.phrase} anchor={anchor} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real messages.
        Hour buckets use Vancouver local time; restart anchors require at least a 6-hour gap.
      </p>
    </div>
  );
}

function HourHeatmap({ cells }: { cells: HourCell[] }) {
  const byDay = WEEKDAYS.map((_, weekday) =>
    cells.filter((cell) => cell.weekday === weekday).sort((a, b) => a.hour - b.hour),
  );
  return (
    <div className="ritual-heatmap-wrap">
      <div className="ritual-heatmap">
        <div className="heatmap-corner" />
        {HOURS.map((hour) => (
          <div key={hour} className="heatmap-hour">{hour}</div>
        ))}
        {byDay.map((row, weekday) => (
          <div className="heatmap-row" key={WEEKDAYS[weekday]}>
            <div className="heatmap-day">{WEEKDAYS[weekday]}</div>
            {row.map((cell) => (
              <div
                key={`${cell.weekday}-${cell.hour}`}
                className="heatmap-cell"
                title={`${cell.weekday_label} ${formatHour(cell.hour)}: ${fmtInt(cell.total)} messages`}
                style={{ backgroundColor: heatColor(cell.level) }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DaypartBar({ part }: { part: DaypartRitual }) {
  const meShare = part.total ? part.me / part.total : 0;
  return (
    <div className="daypart-row">
      <div className="daypart-meta">
        <strong>{part.label}</strong>
        <span>{fmtInt(part.total)} messages · {formatPct(part.share)}</span>
      </div>
      <div className="daypart-track">
        <div className="daypart-fill" style={{ width: `${Math.max(1, part.share * 100)}%` }} />
      </div>
      <div className="sender-split" title={`${formatPct(meShare)} Me`}>
        <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
      </div>
      <div className="hint">Me {formatPct(part.me_share)} · peak {formatHour(part.peak_hour)}</div>
    </div>
  );
}

function PatternCard({ pattern }: { pattern: RitualPattern }) {
  const total = pattern.me + pattern.them;
  const meShare = total ? pattern.me / total : 0;
  return (
    <article className="panel ritual-pattern-card">
      <div className="ritual-card-head">
        <div>
          <div className="turn-block-title">{pattern.label}</div>
          <div className="ritual-count">{fmtInt(pattern.count)}</div>
        </div>
        <div className="ritual-peak">
          {pattern.peak_weekday}
          <span>{formatHour(pattern.peak_hour)}</span>
        </div>
      </div>
      <p>{pattern.description}</p>
      <div className="sender-split">
        <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
      </div>
      <div className="ritual-card-meta">
        <span>Me {fmtInt(pattern.me)}</span>
        <span>Them {fmtInt(pattern.them)}</span>
        <span>{fmtDate(pattern.first_ts)} to {fmtDate(pattern.last_ts)}</span>
      </div>
      <div className="ritual-examples">
        {pattern.examples.map((example) => (
          <ExampleLine key={`${pattern.key}-${example.ts}-${example.sender}`} example={example} />
        ))}
      </div>
    </article>
  );
}

function PhraseAnchorRow({ anchor }: { anchor: PhraseAnchor }) {
  return (
    <div className="phrase-anchor-row">
      <div>
        <strong>{anchor.phrase}</strong>
        <span>{fmtInt(anchor.count)} uses across {fmtInt(anchor.days)} days</span>
      </div>
      <div className="phrase-anchor-metrics">
        <span>{fmtInt(anchor.months)} months</span>
        <span>{formatHour(anchor.peak_hour)}</span>
        <span>{Math.round(anchor.sharedness * 100)}% shared</span>
      </div>
      <a className="evidence-link ritual-anchor-link" href={evidenceHref({ label: "Browse phrase", q: anchor.phrase })}>
        <span>Browse phrase</span>
        <small>{anchor.phrase}</small>
      </a>
    </div>
  );
}

function RestartCard({ anchor }: { anchor: RestartAnchor }) {
  const total = anchor.me + anchor.them;
  const meShare = total ? anchor.me / total : 0;
  return (
    <article className="panel restart-card">
      <div className="restart-card-head">
        <strong>{anchor.phrase}</strong>
        <span>{fmtInt(anchor.count)}</span>
      </div>
      <div className="sender-split">
        <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
      </div>
      <div className="ritual-card-meta">
        <span>Me {fmtInt(anchor.me)}</span>
        <span>Them {fmtInt(anchor.them)}</span>
        <span>avg gap {anchor.avg_gap_hours.toFixed(1)}h</span>
      </div>
      <div className="ritual-examples">
        {anchor.examples.map((example) => (
          <ExampleLine key={`${anchor.phrase}-${example.ts}-${example.sender}`} example={example} q={anchor.phrase} />
        ))}
      </div>
    </article>
  );
}

function ExampleLine({ example, q }: { example: RitualExample; q?: string }) {
  return (
    <div className="ritual-example">
      <span>{example.sender} · {fmtDate(example.ts, { withTime: true })}</span>
      <p>{example.preview}</p>
      <EvidenceLink
        evidence={{
          label: "Browse",
          date: example.ymd,
          sender: example.sender === "Me" ? "me" : "them",
          q,
        }}
      />
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

function heatColor(level: number) {
  if (level <= 0) return "var(--bg-warm)";
  const alpha = 0.1 + level * 0.78;
  return `rgba(184, 67, 47, ${alpha})`;
}

function formatHour(hour: number) {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 || 12;
  return `${h} ${suffix}`;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
