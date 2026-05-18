import { Link, createFileRoute } from "@tanstack/react-router";
import { MeasuredChart } from "~/components/MeasuredChart";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getDesire,
  type DesireEpisode,
  type DesireEra,
  type DesireMonth,
  type DesireSnippet,
} from "~/server/desire-queries";

export const Route = createFileRoute("/desire")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getDesire({ data: deps }),
  component: DesirePage,
});

const SIGNAL_COLORS = {
  signal_desire: "#c95985",
  signal_explicit: "#8f3f73",
  signal_kink: "#6a5aa8",
  signal_media: "#5b6f8f",
  signal_play: "#e0a23a",
  signal_care: "#3f8a85",
};

function DesirePage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Intimacy channel</div>
        <PageTitleRow activePath="/desire" />
        <p className="page-lede">
          The sexual-texting layer split out from romantic affection: scored per message, grouped
          into episodes, then tracked across time by direction, intensity, and mode.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.messages_scored,
            version: "intimacy-score-v1",
            caveats: [
              "Sexual and romantic thresholds are heuristic.",
              "Sensitive excerpts are visible after the site passphrase gate.",
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
        <Stat label="Sexual messages" value={fmtInt(data.overview.sexual_messages)} note={`${fmtInt(data.overview.messages_scored)} messages scored`} />
        <Stat label="Episodes" value={fmtInt(data.overview.sexual_episodes)} note={`${fmtInt(data.overview.active_months)} active months`} />
        <Stat label="Peak month" value={data.overview.peak_month} note="highest weighted score" />
        <Stat label="Now" value={data.overview.current_phase} note={`Me starts ${formatPct(data.overview.me_initiation_share)}`} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Sexual texting over time</h2>
        <div className="panel desire-chart-panel">
          <MeasuredChart className="desire-chart">
            {({ width, height }) => (
              <AreaChart width={width} height={height} data={data.months} margin={{ top: 8, right: 24, bottom: 4, left: -10 }}>
                <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="ym" tick={{ fontSize: 9 }} interval={5} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<MonthTooltip />} />
                <Area type="monotone" dataKey="romantic_score" stroke="#cdb88a" fill="#cdb88a" fillOpacity={0.22} isAnimationActive={false} />
                <Area type="monotone" dataKey="sexual_score" stroke="#8f3f73" fill="#8f3f73" fillOpacity={0.72} isAnimationActive={false} />
              </AreaChart>
            )}
          </MeasuredChart>
          <div className="desire-era-grid">
            {data.eras.map((era) => (
              <EraCard key={era.label} era={era} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Mode palette</h2>
        <div className="panel">
          <MeasuredChart className="desire-chart compact">
            {({ width, height }) => (
              <BarChart width={width} height={height} data={data.months} margin={{ top: 8, right: 24, bottom: 4, left: -10 }}>
                <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="ym" tick={{ fontSize: 9 }} interval={6} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<SignalTooltip />} />
                {Object.entries(SIGNAL_COLORS).map(([key, color]) => (
                  <Bar key={key} dataKey={key} stackId="signals" fill={color} isAnimationActive={false} />
                ))}
              </BarChart>
            )}
          </MeasuredChart>
          <div className="desire-legend">
            <span><b style={{ background: SIGNAL_COLORS.signal_desire }} />desire</span>
            <span><b style={{ background: SIGNAL_COLORS.signal_explicit }} />explicit</span>
            <span><b style={{ background: SIGNAL_COLORS.signal_kink }} />kink</span>
            <span><b style={{ background: SIGNAL_COLORS.signal_media }} />media</span>
            <span><b style={{ background: SIGNAL_COLORS.signal_play }} />play</span>
            <span><b style={{ background: SIGNAL_COLORS.signal_care }} />care</span>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Representative episodes</h2>
        <div className="panel desire-privacy-panel">
          <div>
            <div className="section-kicker">Sensitive excerpts</div>
            <p className="section-copy">
              The passphrase gate is the privacy boundary for this surface. Episode excerpts and browse links are shown directly for the two people who know it.
            </p>
          </div>
          <Link className="btn" to="/desire-patterns" search={(prev) => prev}>
            See patterns
          </Link>
        </div>
        <div className="desire-episode-grid">
          {data.episodes.map((episode) => (
            <EpisodeCard key={episode.key} episode={episode} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {data.overview.generated_at.slice(0, 19).replace("T", " ")} UTC from{" "}
        <code>seg_message_intimacy_scores</code>, <code>seg_segment_categories</code>, and{" "}
        <code>messages</code>.
      </p>
    </div>
  );
}

function EraCard({ era }: { era: DesireEra }) {
  return (
    <article className="desire-era-card">
      <div>
        <strong>{era.label}</strong>
        <span>{era.start_ym} to {era.end_ym}</span>
      </div>
      <p>{fmtInt(era.sexual_messages)} messages</p>
      <p>{era.dominant_signal} / Me {formatPct(era.me_share)}</p>
      <em>{era.note}</em>
    </article>
  );
}

function EpisodeCard({ episode }: { episode: DesireEpisode }) {
  const totalScore = episode.me_score + episode.them_score;
  const meShare = totalScore ? episode.me_score / totalScore : 0;
  return (
    <article className="panel desire-episode-card">
      <div className="desire-episode-head">
        <div>
          <div className="capsule-kicker">{episode.ym} / {episode.mode}</div>
          <h3>{fmtDate(episode.start_ts, { withTime: true })}</h3>
          <div className="hint">
            {fmtDuration(episode.end_ts - episode.start_ts)} / {fmtInt(episode.sexual_messages)} scored turns / starts {episode.initiator}
          </div>
        </div>
        <div className="capsule-score">
          {episode.intensity.toFixed(1)}
          <span>intensity</span>
        </div>
      </div>

      <div className="sender-split">
        <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
      </div>
      <div className="ritual-card-meta">
        <span>Me {episode.me_score.toFixed(1)}</span>
        <span>Them {episode.them_score.toFixed(1)}</span>
        <span>{fmtInt(episode.total_context_messages)} context messages</span>
      </div>

      <div className="capsule-why">
        {episode.signals.map((signal) => (
          <span key={signal}>{signal}</span>
        ))}
      </div>

      <div className="capsule-excerpts">
        {episode.snippets.map((snippet) => (
          <SnippetLine key={snippet.msg_id} snippet={snippet} />
        ))}
      </div>
    </article>
  );
}

function SnippetLine({ snippet }: { snippet: DesireSnippet }) {
  return (
    <div className={snippet.sender === "Me" ? "capsule-excerpt me" : "capsule-excerpt them"}>
      <div>
        <strong>{snippet.sender}</strong>
        <span>{fmtDate(snippet.ts, { withTime: true })}</span>
      </div>
      <p>{snippet.text}</p>
      <EvidenceLink
        evidence={{
          label: "Open day in Browse",
          date: bucket(snippet.ts, "ymd"),
          note: `score ${snippet.sexual_score.toFixed(1)}`,
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

function MonthTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as DesireMonth;
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      <span>sexual score {row.sexual_score.toFixed(1)}</span>
      <span>{fmtInt(row.sexual_messages)} sexual messages</span>
      <span>{fmtInt(row.romantic_messages)} romantic messages</span>
      <span>Me {row.me_score.toFixed(1)} / Them {row.them_score.toFixed(1)}</span>
    </div>
  );
}

function SignalTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const entries = payload.reduce((acc: Array<readonly [string, string]>, item: any) => {
    if (Number(item.value) > 0) acc.push([signalLabel(item.dataKey), Number(item.value).toFixed(1)] as const);
    return acc;
  }, []);
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      {entries.map((entry: readonly [string, string]) => (
        <span key={entry[0]}>{entry[0]} {entry[1]}</span>
      ))}
    </div>
  );
}

function signalLabel(key: string) {
  return key.replace("signal_", "");
}

function formatPct(value: number) {
  return `${Math.round(value * 100)}%`;
}
