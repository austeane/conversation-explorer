import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtInt } from "~/lib/format";
import { bucket } from "~/lib/conversation/time";
import { globalSearchSchema } from "~/routes/_search";
import {
  getRhythms,
  type RhythmLag,
  type RhythmMonth,
  type RhythmPeriod,
  type RhythmSnippet,
  type RhythmWindow,
} from "~/server/rhythm-queries";

export const Route = createFileRoute("/rhythms")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getRhythms({ data: deps }),
  component: RhythmsPage,
});

function RhythmsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const lagMax = Math.max(...data.lags.map((lag) => Math.abs(lag.correlation)), 0.01);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Signal processing</div>
        <PageTitleRow activePath="/rhythms" />
        <p className="page-lede">
          The conversation as a daily signal: hidden cycles, autocorrelation, lead-lag coupling,
          and windows where the thread becomes unusually phase-locked.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.days,
            version: "daily-rhythm-periodogram-v1",
            caveats: [
              "Period peaks depend on detrending and smoothing choices.",
              "Lead-lag correlations are descriptive, not causal.",
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
        <Stat label="Analyzed days" value={fmtInt(data.overview.days)} note={`${fmtInt(data.overview.active_days)} active`} />
        <Stat label="Strongest period" value={data.overview.strongest_period} note={data.overview.strongest_period_feature} />
        <Stat label="Same-day synchrony" value={data.overview.synchrony.toFixed(2)} note="Me/Them daily volume corr" />
        <Stat label="Strongest lag" value={data.overview.strongest_lag} note="nonzero cross-correlation" />
        <Stat label="Current tempo" value={data.overview.current_tempo} note="highest-scoring recent window" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Period spectrum</h2>
        <div className="rhythm-period-grid">
          {data.periods.map((period) => (
            <PeriodCard key={`${period.feature}-${period.period_days}`} period={period} />
          ))}
        </div>
        <p className="hint rhythm-note">
          Method: daily signals are log-scaled where appropriate, locally detrended with a 45-day
          moving average, standardized, then scanned with a simple DFT-style periodogram over 2-180
          day periods. Lift compares each peak to that feature&apos;s median spectral strength.
        </p>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Lead-lag coupling</h2>
        <div className="panel rhythm-lag-panel">
          <div className="rhythm-lag-chart">
            {data.lags.map((lag) => (
              <LagColumn key={lag.lag_days} lag={lag} max={lagMax} />
            ))}
          </div>
          <div className="rhythm-lag-axis">
            <span>Them earlier</span>
            <span>same day</span>
            <span>Me earlier</span>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Monthly rhythm ribbon</h2>
        <div className="panel rhythm-month-panel">
          <div className="rhythm-month-scroll">
            <div className="rhythm-month-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(9px, 1fr))` }}>
              {data.months.map((month) => (
                <MonthColumn key={month.ym} month={month} />
              ))}
            </div>
          </div>
          <p className="hint rhythm-note">
            Tall bars are high message intensity. Blue ticks mark same-month synchrony; red ticks
            mark weekly autocorrelation. The thin dark line rises when strain language becomes
            relatively more present.
          </p>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Phase-locked windows</h2>
        <div className="rhythm-window-grid">
          {data.windows.map((window) => (
            <WindowCard key={`${window.start_ymd}-${window.end_ymd}`} window={window} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.overview.generated_at)}. No tables are added; this
        route computes daily signal features directly from scoped `messages`.
      </p>
    </div>
  );
}

function PeriodCard({ period }: { period: RhythmPeriod }) {
  return (
    <article className="panel rhythm-period-card">
      <div className="rhythm-card-head">
        <div>
          <span>{period.phase_label}</span>
          <strong>{periodLabel(period.period_days)}</strong>
        </div>
        <b>{period.lift.toFixed(1)}x</b>
      </div>
      <div className="rhythm-feature">{period.label}</div>
      <div className="rhythm-sparkline" style={{ gridTemplateColumns: `repeat(${period.sparkline.length}, 1fr)` }}>
        {period.sparkline.map((value, index) => (
          <i key={`${period.feature}-${period.period_days}-${index}`} style={{ height: `${Math.max(8, value * 100)}%` }} />
        ))}
      </div>
      <div className="rhythm-mini-meta">
        <span>strength {period.strength.toFixed(2)}</span>
        <span>baseline {period.baseline_strength.toFixed(2)}</span>
      </div>
    </article>
  );
}

function LagColumn({ lag, max }: { lag: RhythmLag; max: number }) {
  const height = Math.max(5, (Math.abs(lag.correlation) / max) * 100);
  return (
    <div className={`rhythm-lag-column ${lag.lag_days === 0 ? "zero" : lag.lag_days > 0 ? "me" : "them"}`} title={`${lag.direction} ${lag.label}: ${lag.correlation.toFixed(2)}`}>
      <span>{lag.lag_days}</span>
      <i style={{ height: `${height}%` }} />
      <b>{lag.correlation.toFixed(2)}</b>
    </div>
  );
}

function MonthColumn({ month }: { month: RhythmMonth }) {
  const intensity = Math.max(5, Math.min(100, 46 + month.intensity_index * 18));
  const sync = Math.max(0, Math.min(100, 50 + month.synchrony * 42));
  const weekly = Math.max(0, Math.min(100, 50 + month.weekly_memory * 42));
  const strain = Math.max(0, Math.min(100, month.strain_rate * 8));
  return (
    <div className="rhythm-month-column" title={`${month.ym}: ${fmtInt(month.total)} msgs, sync ${month.synchrony.toFixed(2)}, weekly ${month.weekly_memory.toFixed(2)}`}>
      <span className="rhythm-month-volume" style={{ height: `${intensity}%` }} />
      <i className="rhythm-month-sync" style={{ bottom: `${sync}%` }} />
      <i className="rhythm-month-weekly" style={{ bottom: `${weekly}%` }} />
      <em style={{ height: `${strain}%` }} />
    </div>
  );
}

function WindowCard({ window }: { window: RhythmWindow }) {
  return (
    <article className="panel rhythm-window-card">
      <div className="rhythm-card-head">
        <div>
          <span>{window.start_ymd} to {window.end_ymd}</span>
          <strong>{window.label}</strong>
        </div>
        <b>{window.score.toFixed(2)}</b>
      </div>
      <div className="rhythm-window-metrics">
        <Metric label="msgs" value={fmtInt(window.messages)} />
        <Metric label="active" value={`${window.active_days}d`} />
        <Metric label="sync" value={window.synchrony.toFixed(2)} />
        <Metric label="weekly" value={window.weekly_memory.toFixed(2)} />
        <Metric label="period" value={`${window.dominant_period_days}d`} />
        <Metric label="warm" value={`${window.warmth_rate.toFixed(1)}/100`} />
      </div>
      <div className="rhythm-peak">Peak day: {fmtDate(dayTs(window.peak_ymd))}</div>
      <SnippetList snippets={window.snippets} />
    </article>
  );
}

function SnippetList({ snippets }: { snippets: RhythmSnippet[] }) {
  return (
    <div className="rhythm-snippets">
      {snippets.map((snippet) => (
        <div key={`${snippet.ts}-${snippet.text}`}>
          <span>{snippet.sender} · {fmtDate(snippet.ts, { withTime: true })}</span>
          <p>{snippet.text}</p>
          <EvidenceLink
            evidence={{
              label: "Open day in Browse",
              date: bucket(snippet.ts, "ymd"),
              note: "phase-locked window evidence",
            }}
          />
        </div>
      ))}
    </div>
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

function periodLabel(days: number) {
  if (days < 7) return `${days} days`;
  if (days < 31) return `${days} days`;
  if (days < 80) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}

function dayTs(ymd: string) {
  return Date.parse(`${ymd}T12:00:00Z`) / 1000;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
