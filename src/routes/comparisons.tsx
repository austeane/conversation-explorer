import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import {
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  getComparisonOverview,
  type ComparisonNeighbor,
  type ComparisonPerson,
  type ComparisonWord,
  type MetricComparison,
} from "~/server/comparison-queries";
import { fmtDuration, fmtInt } from "~/lib/format";

export const Route = createFileRoute("/comparisons")({
  loader: async () => getComparisonOverview(),
  component: ComparisonsPage,
});

function ComparisonsPage() {
  const { meta, them, people, metrics, extremes, neighbors, words } = Route.useLoaderData();
  const others = people.filter((p) => p.is_them === 0);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Audience tuning</div>
        <PageTitleRow activePath="/comparisons" />
        <p className="page-lede">
          Compared with {fmtInt(others.length)} other one-on-one conversations with at least{" "}
          {fmtInt(Number(meta.min_messages ?? 100))} messages. The cohort uses aggregate features
          from each thread; word comparisons use Me outbound text only.
        </p>
        <p className="hint" style={{ marginTop: "0.55rem" }}>
          Names come from macOS Contacts (with the raw phone or email shown when no contact match
          exists). Other people's message text is not surfaced — only Me's outbound text is
          used for the lexical comparison.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: people.length,
            version: `cmp-etl-${String(meta.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "The cohort is a lifetime snapshot, not a phase-filterable table.",
              "Similarity uses aggregate features and does not expose other people's message text.",
            ],
          }}
          confidence="medium"
        />
      </div>

      <div className="stat-grid">
        <Stat label="Comparison people" value={fmtInt(people.length)} note={`${fmtInt(others.length)} others`} />
        <Stat label="One-on-one messages" value={fmtInt(Number(meta.messages_scanned ?? 0))} note="comparison cohort" />
        <Stat label="Me to Them" value={fmtInt(them.me_messages)} note={`${fmtInt(them.me_words)} analyzed words`} />
        <Stat label="Median reply" value={fmtDuration(them.median_reply_me_sec ?? 0)} note="Me after Them" />
        <Stat
          label="Closest profile"
          value={neighbors[0]?.person.label ?? "n/a"}
          note={neighbors[0] ? `${neighbors[0].similarity}% aggregate match` : undefined}
        />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Audience fingerprint</h2>
        <div className="comparison-fingerprint-grid">
          {extremes.map((metric) => (
            <FingerprintCard key={metric.key} metric={metric} />
          ))}
        </div>
        <div className="panel comparison-metric-panel">
          <div className="hint">
            Percentiles compare Them's thread against the anonymized one-on-one cohort. The rank
            notes show where Them lands among all qualifying high-volume 1:1 chats, including
            Them.
          </div>
          <div className="comparison-metric-list">
            {metrics.map((m) => (
              <MetricBar key={m.key} metric={m} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Nearest audience neighbors</h2>
        <div className="comparison-neighbor-grid">
          {neighbors.map((neighbor) => (
            <NeighborCard key={neighbor.person.id} neighbor={neighbor} />
          ))}
        </div>
        <div className="hint" style={{ marginTop: "0.7rem" }}>
          Similarity uses standardized aggregate features only: Me share, message length,
          questions, emphasis, emoji, attachments, tapbacks, links, reply-thread use, and Me's
          median response time.
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Words Me reserves for each audience</h2>
        <div className="row row-2">
          <WordColumn
            title="More with Them"
            accent="var(--them)"
            words={words.them}
            direction="positive"
            evidence="them"
          />
          <WordColumn
            title="More with other people"
            accent="var(--me)"
            words={words.others}
            direction="negative"
            evidence="aggregate-only"
          />
        </div>
        <div className="hint" style={{ marginTop: "0.7rem" }}>
          Method: Monroe, Colaresi &amp; Quinn 2008 log-odds with an informative Dirichlet prior,
          contrasting Me's messages to Them against Me's messages to the other cohort.
          Them-side words link to the browseable thread; other-cohort words stay aggregate-only.
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Conversation profile map</h2>
        <div className="panel">
          <div className="hint" style={{ marginBottom: "0.7rem" }}>
            x = words per Me text, y = question rate, bubble size = total messages. Them is
            highlighted.
          </div>
          <div className="comparison-map-frame">
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={0}
              initialDimension={{ width: 900, height: 500 }}
            >
              <ScatterChart margin={{ top: 20, right: 28, bottom: 34, left: 8 }}>
                <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="words_per_me_text"
                  tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                  label={{
                    value: "words per Me text",
                    position: "insideBottom",
                    offset: -18,
                    style: { fontSize: 11, fill: "var(--ink-faded)" },
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="question_rate"
                  tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                  tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                  label={{
                    value: "question rate",
                    angle: -90,
                    position: "insideLeft",
                    offset: 18,
                    style: { fontSize: 11, fill: "var(--ink-faded)", textAnchor: "middle" },
                  }}
                />
                <ZAxis type="number" dataKey="messages_total" range={[45, 520]} />
                <Tooltip content={<ProfileTooltip />} />
                <Scatter data={people}>
                  {people.map((p) => (
                    <Cell
                      key={p.id}
                      fill={p.is_them ? "var(--them)" : "var(--ink-faded)"}
                      fillOpacity={p.is_them ? 0.95 : 0.34}
                      stroke={p.is_them ? "var(--ink)" : "transparent"}
                      strokeWidth={p.is_them ? 2 : 0}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <p className="hint" style={{ marginTop: "3rem", textAlign: "center" }}>
        Generated {String(meta.generated_at ?? "").slice(0, 19).replace("T", " ")} UTC via{" "}
        <code>pnpm extract:comparisons</code>. Tables: <code>cmp_people</code>,{" "}
        <code>cmp_distinctive_words</code>. This cohort is not wired to global date or phase
        filters because the comparison ETL currently materializes lifetime profiles.
      </p>
    </div>
  );
}

function FingerprintCard({ metric }: { metric: MetricComparison }) {
  return (
    <div className="comparison-fingerprint-card">
      <div className="comparison-card-kicker">{metric.direction_label}</div>
      <strong>{metric.label}</strong>
      <div className="comparison-fingerprint-value">{formatMetric(metric.value, metric.unit)}</div>
      <div className="comparison-card-note">
        {rankLabel(metric)} · cohort median {formatMetric(metric.other_median, metric.unit)}
      </div>
      <div className="comparison-zline">
        <span>{signed(metric.z_score)} robust z</span>
        <i style={{ width: `${Math.min(100, Math.max(8, Math.abs(metric.z_score) * 24))}%` }} />
      </div>
    </div>
  );
}

function MetricBar({ metric }: { metric: MetricComparison }) {
  const bar = Math.max(2, Math.min(100, metric.standing));
  const cohort = metric.lower_is_more
    ? `faster than ${(100 - metric.percentile).toFixed(0)}%`
    : `higher than ${metric.percentile.toFixed(0)}%`;
  return (
    <div className="comparison-metric-row">
      <div className="comparison-metric-head">
        <div>
          <div className="comparison-metric-title">{metric.label}</div>
          <div className="hint">
            Them {formatMetric(metric.value, metric.unit)} · cohort median{" "}
            {formatMetric(metric.other_median, metric.unit)}
          </div>
        </div>
        <div className="comparison-rank-note">
          {cohort} · {rankLabel(metric)}
        </div>
      </div>
      <div className="comparison-meter">
        <div style={{ width: `${bar}%` }} />
      </div>
      <div className="hint" style={{ marginTop: "0.25rem" }}>
        middle 50% of others: {formatMetric(metric.p25, metric.unit)} to{" "}
        {formatMetric(metric.p75, metric.unit)}
      </div>
    </div>
  );
}

function NeighborCard({ neighbor }: { neighbor: ComparisonNeighbor }) {
  return (
    <div className="comparison-neighbor-card">
      <div className="comparison-neighbor-head">
        <div>
          <div className="comparison-card-kicker">{neighbor.person.label}</div>
          <strong>{neighbor.similarity}% similar</strong>
        </div>
        <span>{fmtInt(neighbor.person.messages_total)} msgs</span>
      </div>
      <div className="comparison-chip-row">
        {neighbor.shared_traits.length ? (
          neighbor.shared_traits.map((trait) => <span key={trait}>{trait}</span>)
        ) : (
          <span>no strong shared extremes</span>
        )}
      </div>
      <div className="comparison-diff-list">
        {neighbor.differences.map((diff) => (
          <div key={diff.key} className="comparison-diff-row">
            <span>{diff.label}</span>
            <strong>
              {formatMetric(diff.them_value, diff.unit)} / {formatMetric(diff.neighbor_value, diff.unit)}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function WordColumn({
  title,
  accent,
  words,
  direction,
  evidence,
}: {
  title: string;
  accent: string;
  words: ComparisonWord[];
  direction: "positive" | "negative";
  evidence: "them" | "aggregate-only";
}) {
  return (
    <div className="panel">
      <div className="hint" style={{ marginBottom: "0.7rem", color: accent, fontWeight: 600 }}>
        {title.toUpperCase()}
      </div>
      <table className="kv-list" style={{ fontFamily: "var(--font-mono)" }}>
        <tbody>
          {words.slice(0, 30).map((w) => (
            <tr key={w.word}>
              <td
                style={{
                  textTransform: "none",
                  letterSpacing: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.82rem",
                  color: "var(--ink)",
                  fontWeight: 500,
                  width: "auto",
                }}
              >
                {w.word}
              </td>
              <td style={{ width: "auto", textAlign: "right" }}>
                <span style={{ color: accent, fontWeight: 600 }}>
                  {direction === "positive" ? "+" : ""}
                  {w.log_odds_z.toFixed(2)}
                </span>{" "}
                <span className="hint" style={{ fontSize: "0.65rem" }}>
                  {fmtInt(direction === "positive" ? w.count_them : w.count_others)}
                </span>
                {evidence === "them" && (
                  <div style={{ marginTop: "0.25rem" }}>
                    <EvidenceLink
                      evidence={{
                        label: "Browse",
                        q: w.word,
                        sender: "me",
                        note: `${fmtInt(w.count_them)} Me-to-Them uses`,
                      }}
                    />
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfileTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as ComparisonPerson;
  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--ink)",
        padding: "0.55rem 0.7rem",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{p.label}</div>
      <div>{fmtInt(p.messages_total)} total messages</div>
      <div>{formatMetric(p.words_per_me_text, "number")} words / Me text</div>
      <div>{formatMetric(p.question_rate, "percent")} question rate</div>
      <div>{formatMetric(p.emoji_per_me_text, "number")} emoji / Me text</div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function formatMetric(value: number, unit: MetricComparison["unit"]): string {
  if (unit === "percent") return `${(value * 100).toFixed(1)}%`;
  if (unit === "seconds") return fmtDuration(value);
  return value.toFixed(2);
}

function rankLabel(metric: MetricComparison): string {
  const lowDirection = metric.key === "median_reply_me_sec" ? "fastest" : "lowest";
  const highDirection = metric.key === "median_reply_me_sec" ? "slowest" : "highest";
  const useHigh = metric.percentile >= 50;
  return `#${useHigh ? metric.rank_high : metric.rank_low} ${useHigh ? highDirection : lowDirection} of ${metric.cohort_count}`;
}

function signed(value: number): string {
  return value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}
