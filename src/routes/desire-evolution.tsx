import { createFileRoute } from "@tanstack/react-router";
import { MeasuredChart } from "~/components/MeasuredChart";
import { MethodBadge } from "~/components/MethodBadge";
import { PageTitleRow } from "~/components/PageTitleRow";
import { fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getDesireEvolution,
  type DesireEvolutionYear,
  type DesireMonth,
} from "~/server/desire-queries";

export const Route = createFileRoute("/desire-evolution")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getDesireEvolution({ data: deps }),
  component: DesireEvolutionPage,
});

const SIGNAL_COLORS = {
  signal_desire: "#c95985",
  signal_explicit: "#8f3f73",
  signal_kink: "#6a5aa8",
  signal_media: "#5b6f8f",
  signal_play: "#e0a23a",
  signal_care: "#3f8a85",
};

function DesireEvolutionPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const totalMessages = data.years.reduce((sum, year) => sum + year.sexual_messages, 0);
  const totalSessions = data.years.reduce((sum, year) => sum + year.sessions, 0);
  const peakYear = [...data.years].sort((a, b) => b.sexual_messages - a.sexual_messages)[0];
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Intimacy channel</div>
        <PageTitleRow activePath="/desire-evolution" />
        <p className="page-lede">
          How the sexual channel changes over time: yearly volume, reciprocal sessions, dominant
          modes, kink motifs, and the places where the texture noticeably turns.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: totalMessages,
            version: "intimacy-evolution-v1",
            caveats: [
              "Yearly comparisons use message counts and weighted intimacy scores.",
              "Dominant motifs are lexical summaries, not fixed identities.",
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
        <Stat label="Sexual messages" value={fmtInt(totalMessages)} note={`${fmtInt(totalSessions)} sessions`} />
        <Stat label="Peak year" value={peakYear?.year ?? "n/a"} note={peakYear ? `${fmtInt(peakYear.sexual_messages)} messages` : "no active year"} />
        <Stat label="Recent mode" value={data.years.at(-1)?.dominant_signal ?? "n/a"} note={data.years.at(-1)?.dominant_motif ?? "no motif"} />
        <Stat label="Years" value={fmtInt(data.years.length)} note="with sexual-scored messages" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly mode mix</h2>
        <div className="panel desire-chart-panel">
          <MeasuredChart className="desire-chart compact">
            {({ width, height }) => (
              <BarChart width={width} height={height} data={data.months} margin={{ top: 8, right: 24, bottom: 4, left: -10 }}>
                <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="ym" tick={{ fontSize: 9 }} interval={6} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<ModeTooltip />} />
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
        <h2><span className="num">02</span> Yearly shifts</h2>
        <div className="desire-year-grid">
          {data.years.map((year) => (
            <YearCard key={year.year} year={year} maxMessages={peakYear?.sexual_messages ?? 1} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {data.generated_at.slice(0, 19).replace("T", " ")} UTC from{" "}
        <code>seg_message_intimacy_scores</code>, <code>messages</code>, and session grouping.
      </p>
    </div>
  );
}

function YearCard({ year, maxMessages }: { year: DesireEvolutionYear; maxMessages: number }) {
  return (
    <article className="desire-year-card">
      <div className="desire-year-head">
        <div>
          <div className="capsule-kicker">{year.start_ym} to {year.end_ym}</div>
          <h3>{year.year}</h3>
        </div>
        <strong>{formatChange(year.change_from_previous)}</strong>
      </div>
      <div className="desire-meter" aria-label={`${year.sexual_messages} sexual messages`}>
        <span style={{ width: `${Math.max(2, (year.sexual_messages / Math.max(1, maxMessages)) * 100)}%` }} />
      </div>
      <p>{year.change_note}</p>
      <div className="desire-pattern-facts">
        <span>{fmtInt(year.sexual_messages)} messages</span>
        <span>{fmtInt(year.sessions)} sessions</span>
        <span>{fmtInt(year.reciprocal_sessions)} reciprocal</span>
        <span>Me {formatPct(year.me_share)}</span>
        <span>{year.dominant_signal}</span>
        <span>{year.dominant_motif}</span>
        <span>Avg {fmtDuration(year.average_session_minutes * 60)}</span>
        <span>{year.average_session_turns.toFixed(1)} turns/session</span>
      </div>
    </article>
  );
}

function ModeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as DesireMonth;
  const entries = payload.reduce((acc: Array<readonly [string, string]>, item: any) => {
    if (Number(item.value) > 0) acc.push([signalLabel(item.dataKey), Number(item.value).toFixed(1)] as const);
    return acc;
  }, []);
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      <span>{fmtInt(row.sexual_messages)} sexual messages</span>
      {entries.map((entry: readonly [string, string]) => (
        <span key={entry[0]}>{entry[0]} {entry[1]}</span>
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

function signalLabel(key: string) {
  return key.replace("signal_", "");
}

function formatChange(value: number | null) {
  if (value == null) return "new";
  if (value === 0) return "0";
  return value > 0 ? `+${fmtInt(value)}` : `-${fmtInt(Math.abs(value))}`;
}

function formatPct(value: number) {
  return `${Math.round(value * 100)}%`;
}
