import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtInt } from "~/lib/format";
import {
  getRecurrence,
  type RecurrenceEcho,
  type RecurrenceFrontier,
  type RecurrenceLine,
  type RecurrencePoint,
  type RecurrenceSnippet,
  type RecurrenceWeek,
} from "~/server/recurrence-queries";

export const Route = createFileRoute("/recurrence")({
  loader: async () => getRecurrence(),
  component: RecurrencePage,
});

function RecurrencePage() {
  const data = Route.useLoaderData();
  const currentReturn = splitCurrentReturn(data.overview.current_return);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Nonlinear dynamics</div>
        <PageTitleRow activePath="/recurrence" />
        <p className="page-lede">
          A recurrence plot for the relationship: every active week becomes a state vector, then
          distant weeks are linked when their tempo, balance, affect, objects, and semantic mix
          return to a similar shape.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.active_weeks,
            version: `recurrence-${String(data.overview.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Full-archive weekly state-space view; filters would change the standardized feature space.",
              "The recurrence rate is target-tuned by the fixed-radius threshold.",
              "Feature weights mix message rates with segment-category labels.",
            ],
          }}
          confidence="medium"
        />
      </div>

      <div className="stat-grid">
        <Stat label="Active weeks" value={fmtInt(data.overview.active_weeks)} note="18+ real messages" />
        <Stat label="Recurrence rate" value={formatPct(data.overview.recurrence_rate)} note="fixed-radius return density" />
        <Stat label="Determinism" value={formatPct(data.overview.determinism)} note="points inside diagonal returns" />
        <Stat label="Laminarity" value={formatPct(data.overview.laminarity)} note="weeks that keep matching a prior state" />
        <Stat label="Current return" value={currentReturn.value} note={currentReturn.note} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Recurrence plot</h2>
        <div className="panel recurrence-plot-panel">
          <div className="recurrence-plot-head">
            <p>
              Each dot is a pair of weeks at least eight weeks apart whose state vectors fall
              inside the recurrence radius. Diagonal traces mean a whole sequence repeated; vertical
              stacks mean one era resembles several nearby later eras.
            </p>
            <b>{fmtInt(data.points.length)} sampled pairs</b>
          </div>
          <RecurrencePlot weeks={data.weeks} points={data.points} />
          <WeekTimeline weeks={data.weeks} />
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Distant echoes</h2>
        <div className="recurrence-echo-grid">
          {data.echoes.map((echo) => (
            <EchoCard key={echo.key} echo={echo} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Returning corridors</h2>
        <div className="row row-2">
          <div className="recurrence-list">
            {data.lines.map((line) => (
              <LineCard key={line.key} line={line} />
            ))}
          </div>
          <div className="recurrence-list">
            {data.frontiers.map((frontier) => (
              <FrontierCard key={frontier.key} frontier={frontier} />
            ))}
          </div>
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {data.overview.generated_at.slice(0, 19).replace("T", " ")} UTC. Method:
        weekly state vectors, z-scored feature space, fixed recurrence radius, diagonal-line RQA,
        laminarity scan, and diverse distant-pair evidence.
      </p>
    </div>
  );
}

function RecurrencePlot({ weeks, points }: { weeks: RecurrenceWeek[]; points: RecurrencePoint[] }) {
  const denom = Math.max(weeks.length - 1, 1);
  const scale = (index: number) => 4 + (index / denom) * 92;
  const invert = (index: number) => 96 - (index / denom) * 92;

  return (
    <div className="recurrence-plot-wrap">
      <svg className="recurrence-plot" viewBox="0 0 100 100" role="img" aria-label="Recurrence plot of weekly conversation states">
        <rect x="4" y="4" width="92" height="92" className="recurrence-frame" />
        <line x1="4" y1="96" x2="96" y2="4" className="recurrence-diagonal" />
        {points.map((point) => {
          const opacity = Math.max(0.18, Math.min(0.86, point.similarity));
          const radius = point.gap_weeks > 104 ? 0.46 : 0.34;
          return (
            <g key={`${point.left_index}-${point.right_index}`}>
              <circle cx={scale(point.left_index)} cy={invert(point.right_index)} r={radius} opacity={opacity} />
              <circle cx={scale(point.right_index)} cy={invert(point.left_index)} r={radius} opacity={opacity * 0.72} />
            </g>
          );
        })}
      </svg>
      <div className="recurrence-axis">
        <span>{weeks[0]?.key}</span>
        <span>{weeks[Math.floor(weeks.length / 2)]?.key}</span>
        <span>{weeks[weeks.length - 1]?.key}</span>
      </div>
    </div>
  );
}

function WeekTimeline({ weeks }: { weeks: RecurrenceWeek[] }) {
  return (
    <div className="recurrence-week-scroll">
      <div className="recurrence-week-strip" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(5px, 1fr))` }}>
        {weeks.map((week) => (
          <i
            key={week.key}
            title={`${week.key}: ${week.label}, ${fmtInt(week.messages)} messages, ${fmtInt(week.recurrence_count)} returns, novelty ${week.novelty.toFixed(2)}`}
            style={{
              height: `${Math.max(5, week.height * 100)}%`,
              opacity: `${Math.max(0.28, 1 - week.novelty * 0.6)}`,
            }}
          />
        ))}
      </div>
      <div className="recurrence-axis">
        <span>low return density</span>
        <span>weekly recurrence density</span>
        <span>high return density</span>
      </div>
    </div>
  );
}

function EchoCard({ echo }: { echo: RecurrenceEcho }) {
  return (
    <article className="panel recurrence-echo-card">
      <div className="recurrence-card-head">
        <div>
          <span>{fmtDate(echo.left_ts)} returns on {fmtDate(echo.right_ts)}</span>
          <strong>{echo.label}</strong>
        </div>
        <b>{echo.similarity.toFixed(2)}</b>
      </div>
      <div className="recurrence-tags">
        <span>{echo.gap_weeks} weeks apart</span>
        {echo.shared_features.map((feature) => (
          <span key={feature}>{feature}</span>
        ))}
      </div>
      <div className="recurrence-snippet-pair">
        <SnippetColumn label={echo.left_key} snippets={echo.left_snippets} />
        <SnippetColumn label={echo.right_key} snippets={echo.right_snippets} />
      </div>
    </article>
  );
}

function LineCard({ line }: { line: RecurrenceLine }) {
  return (
    <article className="panel recurrence-line-card">
      <div className="recurrence-card-head">
        <div>
          <span>{fmtDate(line.left_start_ts)} to {fmtDate(line.right_start_ts)}</span>
          <strong>{line.label}</strong>
        </div>
        <b>{line.length_weeks}w</b>
      </div>
      <div className="recurrence-tags">
        <span>{line.gap_weeks} week return gap</span>
        <span>{line.similarity.toFixed(2)} avg similarity</span>
        {line.shared_features.map((feature) => (
          <span key={feature}>{feature}</span>
        ))}
      </div>
    </article>
  );
}

function FrontierCard({ frontier }: { frontier: RecurrenceFrontier }) {
  return (
    <article className="panel recurrence-frontier-card">
      <div className="recurrence-card-head">
        <div>
          <span>{fmtDate(frontier.start_ts)} · nearest prior {frontier.nearest_return}</span>
          <strong>{frontier.label} frontier</strong>
        </div>
        <b>{frontier.novelty.toFixed(2)}</b>
      </div>
      <div className="recurrence-tags">
        <span>{fmtInt(frontier.messages)} messages</span>
        <span>high novelty before any return</span>
      </div>
      <SnippetColumn label={frontier.key} snippets={frontier.snippets} />
    </article>
  );
}

function SnippetColumn({ label, snippets }: { label: string; snippets: RecurrenceSnippet[] }) {
  return (
    <div className="recurrence-snippets">
      <div>{label}</div>
      {snippets.map((snippet) => (
        <p key={`${snippet.ts}-${snippet.text}`}>
          <span>{snippet.sender} · {fmtDate(snippet.ts, { withTime: true })}</span>
          {snippet.text}
          <EvidenceLink
            evidence={{
              label: "Open day in Browse",
              date: bucket(snippet.ts, "ymd"),
              note: `${label} recurrence evidence`,
            }}
          />
        </p>
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

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function splitCurrentReturn(value: string) {
  const match = value.match(/^(.*) \((.*)\)$/);
  if (!match) return { value, note: "nearest older state" };
  return { value: match[1], note: `${match[2]} current return` };
}
