import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { senderShortLabel, useRuntimeIdentity, type RuntimeIdentity } from "~/lib/conversation/runtime-identity";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getDynamics,
  type LongRun,
  type LullRecovery,
  type Sender,
} from "~/server/dynamics-queries";

export const Route = createFileRoute("/dynamics")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getDynamics({ data: deps }),
  component: DynamicsPage,
});

function DynamicsPage() {
  const { overview, monthly, lulls, runs } = Route.useLoaderData();
  const search = Route.useSearch();
  const identity = useRuntimeIdentity();
  const meLabel = senderShortLabel(identity, "me");
  const themLabel = senderShortLabel(identity, "them");
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const latest = monthly[monthly.length - 1];
  const plotted = monthly.map((m) => ({
    ...m,
    me_reply_minutes:
      m.median_me_reply_seconds == null ? null : m.median_me_reply_seconds / 60,
    them_reply_minutes:
      m.median_them_reply_seconds == null ? null : m.median_them_reply_seconds / 60,
    me_reply_index:
      m.median_me_reply_seconds == null ? null : Math.log10(m.median_me_reply_seconds + 1),
    them_reply_index:
      m.median_them_reply_seconds == null ? null : Math.log10(m.median_them_reply_seconds + 1),
    me_restart_pct:
      m.me_restart_share == null ? null : Math.round(m.me_restart_share * 1000) / 10,
  }));
  const tempoData = plotted.filter((m) => m.ym >= "2022-01");
  const tempoMax = tempoData.reduce((acc, m) => {
    const a = m.me_reply_index ?? 0;
    const s = m.them_reply_index ?? 0;
    return Math.max(acc, a, s);
  }, 0);
  const tempoCeil = Math.max(1, Math.ceil(tempoMax * 2) / 2);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Dialogue dynamics</div>
        <PageTitleRow activePath="/dynamics" />
        <p className="page-lede">
          Turn-taking, replies, restarts after silences, and message bursts. This view treats the
          archive as a dialogue system rather than a bag of words.
        </p>
        <MethodBadge
          meta={{
            kind: "descriptive",
            sample: overview.real_messages,
            version: "dialogue-dynamics-v1",
            caveats: [
              "Tapbacks are excluded from turn and reply calculations.",
              "Reply timing uses adjacent cross-sender messages, not explicit reply links.",
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
        <Stat label="Real messages" value={fmtInt(overview.real_messages)} note={`${fmtInt(overview.turns)} sender runs`} />
        <Stat label={`${meLabel} reply`} value={formatNullableDuration(overview.median_me_reply_seconds)} note={`median after ${themLabel}`} />
        <Stat label={`${themLabel} reply`} value={formatNullableDuration(overview.median_them_reply_seconds)} note={`median after ${meLabel}`} />
        <Stat label={`${meLabel} restarts`} value={formatPct(overview.me_restart_share)} note="after 6h+ silence" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Reply tempo</h2>
        <div className="panel">
          <div className="hint dynamics-note">
            Median monthly reply time when the previous real message came from the other person
            and the response landed within 24 hours. The vertical scale is logarithmic so seconds
            and hours can share one chart.
          </div>
          <div className="turn-chart">
            <TempoChart data={tempoData} maxIndex={tempoCeil} identity={identity} />
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Who reopens the room</h2>
        <div className="row row-2">
          <div className="panel">
            <div className="hint dynamics-note">
              Share of first messages after a silence of at least 6 hours. Latest month:{" "}
              {latest ? `${latest.ym}, ${formatNullablePct(latest.me_restart_share)} ${meLabel}` : "n/a"}.
            </div>
            <div className="restart-sparkline">
              {plotted.map((m) => (
                <div className="restart-month" key={m.ym} title={`${m.ym}: ${formatNullablePct(m.me_restart_share)} ${meLabel}`}>
                  <div
                    className="restart-bar"
                    style={{ height: `${Math.max(3, m.me_restart_pct ?? 0)}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="restart-axis">
              <span>{monthly[0]?.ym}</span>
              <span>{latest?.ym}</span>
            </div>
          </div>

          <div className="panel">
            <div className="turn-block-title">Burst shape</div>
            <div className="dynamics-pair">
              <BurstMetric sender="me" value={overview.avg_me_run_messages} identity={identity} />
              <BurstMetric sender="them" value={overview.avg_them_run_messages} identity={identity} />
            </div>
            <p className="hint dynamics-note">
              A sender run is a sequence of messages sent before the other person replies. Longer
              runs mean monologues, live updates, or multi-part thoughts.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Longest lulls and reopenings</h2>
        <div className="dynamics-list">
          {lulls.map((lull) => (
            <LullCard key={`${lull.start_ts}-${lull.end_ts}`} lull={lull} identity={identity} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Longest sender runs</h2>
        <div className="dynamics-list">
          {runs.map((run) => (
            <RunCard key={`${run.start_ts}-${run.sender}`} run={run} identity={identity} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {overview.generated_at.slice(0, 19).replace("T", " ")} UTC from real messages,
        excluding tapbacks from turn and reply calculations.
      </p>
    </div>
  );
}

function LullCard({ lull, identity }: { lull: LullRecovery; identity: RuntimeIdentity }) {
  return (
    <article className="panel dynamics-card">
      <div className="dynamics-card-head">
        <div>
          <div className="dynamics-big">{fmtDuration(lull.gap_seconds)}</div>
          <div className="hint">{fmtDate(lull.start_ts)} to {fmtDate(lull.end_ts)}</div>
        </div>
        <SenderBadge sender={lull.reopened_by} label="reopened" identity={identity} />
      </div>
      <p>{lull.preview}</p>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open lull in Browse",
            from: bucket(lull.start_ts, "ymd"),
            to: bucket(lull.end_ts, "ymd"),
            note: `${senderShortLabel(identity, lull.previous_sender)} to ${senderShortLabel(identity, lull.reopened_by)}`,
          }}
        />
      </div>
      <div className="hint">Previous real message: {senderShortLabel(identity, lull.previous_sender)}</div>
    </article>
  );
}

function RunCard({ run, identity }: { run: LongRun; identity: RuntimeIdentity }) {
  return (
    <article className="panel dynamics-card">
      <div className="dynamics-card-head">
        <div>
          <div className="dynamics-big">{fmtInt(run.n_messages)} messages</div>
          <div className="hint">
            {fmtDate(run.start_ts, { withTime: true })} · {fmtDuration(run.duration_seconds)}
          </div>
        </div>
        <SenderBadge sender={run.sender} label={`${fmtInt(run.words)} words`} identity={identity} />
      </div>
      <p>{run.preview}</p>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open run in Browse",
            from: bucket(run.start_ts, "ymd"),
            to: bucket(run.end_ts, "ymd"),
            note: `${senderShortLabel(identity, run.sender)}, ${fmtInt(run.n_messages)} messages`,
          }}
        />
      </div>
    </article>
  );
}

function BurstMetric({ sender, value, identity }: { sender: Sender; value: number; identity: RuntimeIdentity }) {
  return (
    <div className="burst-metric">
      <SenderBadge sender={sender} label="average run" identity={identity} />
      <div className="dynamics-big">{value.toFixed(2)}</div>
      <div className="hint">messages before handoff</div>
    </div>
  );
}

function SenderBadge({ sender, label, identity }: { sender: Sender; label: string; identity: RuntimeIdentity }) {
  return (
    <div className={sender === "me" ? "sender-badge me" : "sender-badge them"}>
      <span>{senderShortLabel(identity, sender)}</span>
      <small>{label}</small>
    </div>
  );
}

type TempoPoint = {
  ym: string;
  total: number;
  me_reply_minutes: number | null;
  them_reply_minutes: number | null;
  me_reply_index: number | null;
  them_reply_index: number | null;
};

function TempoChart({ data, maxIndex, identity }: { data: TempoPoint[]; maxIndex: number; identity: RuntimeIdentity }) {
  const ticks: number[] = [];
  for (let tick = 1; tick <= maxIndex; tick += 1) ticks.push(tick);
  const mePath = linePath(data, "me_reply_index", maxIndex);
  const themPath = linePath(data, "them_reply_index", maxIndex);
  if (!mePath && !themPath) {
    return <div className="tempo-empty">No cross-sender reply pairs under the current filters.</div>;
  }

  return (
    <div className="tempo-chart-frame" role="img" aria-label="Monthly reply tempo for Me and Them">
      <svg className="tempo-chart-svg" viewBox="0 0 1000 260">
        {ticks.map((tick) => {
          const y = tempoY(tick, maxIndex);
          return (
            <g key={tick}>
              <line className="tempo-grid-line" x1="0" x2="1000" y1={y} y2={y} />
              <text className="tempo-axis-label" x="0" y={y - 4}>{formatReplyIndex(tick)}</text>
            </g>
          );
        })}
        {mePath && <path className="tempo-line me" d={mePath} />}
        {themPath && <path className="tempo-line them" d={themPath} />}
        {data.map((point, index) => (
          <g key={point.ym}>
          <TempoDot point={point} index={index} count={data.length} maxIndex={maxIndex} series="me" identity={identity} />
          <TempoDot point={point} index={index} count={data.length} maxIndex={maxIndex} series="them" identity={identity} />
          </g>
        ))}
      </svg>
      <div className="restart-axis">
        <span>{data[0]?.ym}</span>
        <span>{data[data.length - 1]?.ym}</span>
      </div>
    </div>
  );
}

function TempoDot({
  point,
  index,
  count,
  maxIndex,
  series,
  identity,
}: {
  point: TempoPoint;
  index: number;
  count: number;
  maxIndex: number;
  series: "me" | "them";
  identity: RuntimeIdentity;
}) {
  const value = series === "me" ? point.me_reply_index : point.them_reply_index;
  if (value == null) return null;
  const minutes = series === "me" ? point.me_reply_minutes : point.them_reply_minutes;
  const label = senderShortLabel(identity, series);
  return (
    <circle
      className={`tempo-dot ${series}`}
      cx={tempoX(index, count)}
      cy={tempoY(value, maxIndex)}
      r="4"
      vectorEffect="non-scaling-stroke"
    >
      <title>{`${point.ym}: ${label} ${formatMinutes(minutes)}, ${fmtInt(point.total)} messages`}</title>
    </circle>
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
  return `${Math.round(value * 100)}%`;
}

function formatNullablePct(value: number | null) {
  return value == null ? "n/a" : formatPct(value);
}

function formatMinutes(value: number | null) {
  if (value == null) return "n/a";
  if (value < 60) return `${Math.round(value)}m`;
  return `${(value / 60).toFixed(1)}h`;
}

function formatNullableDuration(value: number | null) {
  return value == null ? "n/a" : fmtDuration(value);
}

function formatReplyIndex(value: number) {
  const seconds = Math.pow(10, value) - 1;
  return fmtDuration(seconds);
}

function linePath(data: TempoPoint[], key: "me_reply_index" | "them_reply_index", maxIndex: number) {
  let path = "";
  let open = false;
  data.forEach((point, index) => {
    const value = point[key];
    if (value == null) {
      open = false;
      return;
    }
    const command = open ? "L" : "M";
    path += `${command}${tempoX(index, data.length).toFixed(2)},${tempoY(value, maxIndex).toFixed(2)} `;
    open = true;
  });
  return path.trim();
}

function tempoX(index: number, count: number) {
  return count <= 1 ? 0 : (index / (count - 1)) * 1000;
}

function tempoY(value: number, maxIndex: number) {
  return 248 - (Math.min(value, maxIndex) / Math.max(maxIndex, 1)) * 228;
}
