import { createFileRoute } from "@tanstack/react-router";
import { evidenceHref } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { PageTitleRow } from "~/components/PageTitleRow";
import {
  getCollocations,
  getDistinctivePhrases,
  getSentenceStats,
  getTopPhrases,
  type CollocationRow,
  type PhraseDivergence,
  type SentenceStatsResponse,
  type TopPhraseRow,
} from "~/server/phrase-queries";
import { fmtInt } from "~/lib/format";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/phrases")({
  loader: async () => {
    const [
      sentence,
      collocLlr,
      collocPmi,
      collocT,
      div2,
      div3,
      topBiAll,
      topBiMe,
      topBiThem,
      topTriAll,
      topTriMe,
      topTriThem,
    ] = await Promise.all([
      getSentenceStats(),
      getCollocations({ data: { metric: "llr", limit: 80 } }),
      getCollocations({ data: { metric: "pmi", limit: 80 } }),
      getCollocations({ data: { metric: "tscore", limit: 80 } }),
      getDistinctivePhrases({ data: { n: 2, direction: "all", limit: 1000 } }),
      getDistinctivePhrases({ data: { n: 3, direction: "all", limit: 1000 } }),
      getTopPhrases({ data: { n: 2, sender: "all", limit: 40 } }),
      getTopPhrases({ data: { n: 2, sender: "me", limit: 40 } }),
      getTopPhrases({ data: { n: 2, sender: "them", limit: 40 } }),
      getTopPhrases({ data: { n: 3, sender: "all", limit: 40 } }),
      getTopPhrases({ data: { n: 3, sender: "me", limit: 40 } }),
      getTopPhrases({ data: { n: 3, sender: "them", limit: 40 } }),
    ]);
    return {
      sentence,
      colloc: { llr: collocLlr, pmi: collocPmi, tscore: collocT },
      divergence: { 2: div2, 3: div3 } as Record<2 | 3, PhraseDivergence[]>,
      top: {
        2: { all: topBiAll, me: topBiMe, them: topBiThem },
        3: { all: topTriAll, me: topTriMe, them: topTriThem },
      } as Record<2 | 3, Record<"all" | "me" | "them", TopPhraseRow[]>>,
    };
  },
  component: PhrasesPage,
});

type Metric = "llr" | "pmi" | "tscore";
type N = 2 | 3;

function PhrasesPage() {
  const { sentence, colloc, divergence, top } = Route.useLoaderData();
  const [metric, setMetric] = useState<Metric>("llr");
  const [divN, setDivN] = useState<N>(2);
  const [topN, setTopN] = useState<N>(2);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Phrases &amp; sentences</div>
        <PageTitleRow activePath="/phrases" />
        <p className="page-lede">
          Words don&rsquo;t live alone. Below: how each person packs sentences,
          which two- and three-word phrases bind together unusually tightly, and
          which ones each person says distinctively more than the other.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: sentence.me.n_sentences + sentence.them.n_sentences,
            version: "phrases-etl-v1",
            caveats: ["Phrase tables are precomputed over the full archive."],
          }}
          confidence="medium"
        />
      </div>

      <SentenceSection sentence={sentence} />

      <CollocationsSection colloc={colloc} metric={metric} setMetric={setMetric} />

      <DistinctiveSection divergence={divergence} divN={divN} setDivN={setDivN} />

      <TopPhrasesSection top={top} topN={topN} setTopN={setTopN} />

      <p className="hint" style={{ marginTop: "3rem", textAlign: "center" }}>
        N-grams sentence-bounded; tokenizer matches the Vocabulary page (curly-apostrophe
        normalised, stop-words removed). Collocations: Manning &amp; Sch&uuml;tze ch.&nbsp;5
        (LLR / PMI / t-score) on the combined corpus. Distinctive phrases: Monroe, Colaresi
        &amp; Quinn 2008 with informative Dirichlet prior, &alpha;<sub>0</sub> = 100.
      </p>
    </div>
  );
}

// ----- 01: sentence stats -----

function SentenceSection({ sentence }: { sentence: SentenceStatsResponse }) {
  const histRows = useMemo(() => {
    const order = ["0-4", "5-9", "10-19", "20-49", "50+"];
    const meByBucket = new Map(sentence.hist.me.map((r) => [r.bucket, r.n_count]));
    const themByBucket = new Map(sentence.hist.them.map((r) => [r.bucket, r.n_count]));
    return order.map((b) => ({
      bucket: b,
      me: meByBucket.get(b) ?? 0,
      them: themByBucket.get(b) ?? 0,
    }));
  }, [sentence]);

  return (
    <section className="section">
      <h2><span className="num">01</span> Sentences</h2>
      <div className="row row-2">
        <div className="panel">
          <div className="hint" style={{ marginBottom: "0.7rem" }}>
            How long, how punctuated, how readable.
          </div>
          <table className="kv-list">
            <tbody>
              <SentenceStatRow label="Sentences counted" me={sentence.me.n_sentences} them={sentence.them.n_sentences} fmt="int" />
              <SentenceStatRow label="Mean words / sentence" me={sentence.me.mean_words} them={sentence.them.mean_words} fmt="dec1" />
              <SentenceStatRow label="Median words" me={sentence.me.median_words} them={sentence.them.median_words} fmt="dec0" />
              <SentenceStatRow label="P90 words" me={sentence.me.p90_words} them={sentence.them.p90_words} fmt="dec0" />
              <SentenceStatRow label="Question rate" me={sentence.me.question_rate} them={sentence.them.question_rate} fmt="pct" />
              <SentenceStatRow label="Exclamation rate" me={sentence.me.excl_rate} them={sentence.them.excl_rate} fmt="pct" />
              <SentenceStatRow label="Emoji / sentence" me={sentence.me.emoji_rate} them={sentence.them.emoji_rate} fmt="dec2" />
              <SentenceStatRow label="Flesch-Kincaid grade" me={sentence.me.fk_grade} them={sentence.them.fk_grade} fmt="dec1" />
            </tbody>
          </table>
          <div className="hint" style={{ marginTop: "0.7rem", fontStyle: "italic" }}>
            FK grade is approximate (vowel-group syllable estimate). Lower = simpler, more chat-like.
          </div>
        </div>
        <div className="panel">
          <div className="hint" style={{ marginBottom: "0.7rem" }}>
            Sentence length distribution (words per sentence).
          </div>
          <MeasuredChartFrame height={280}>
            {({ width, height }) => (
              <BarChart width={width} height={height} data={histRows} margin={{ top: 4, right: 8, bottom: 4, left: -10 }}>
                <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                <YAxis tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }} />
                <Tooltip
                  contentStyle={{ fontSize: 12, fontFamily: "var(--font-mono)" }}
                  formatter={((v: number, k: string) => [fmtInt(v), k === "me" ? "Me" : "Them"]) as any}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)", paddingTop: 8 }}
                  formatter={(value) => (value === "me" ? "Me" : "Them")}
                />
                <Bar dataKey="me" fill="var(--me)" />
                <Bar dataKey="them" fill="var(--them)" />
              </BarChart>
            )}
          </MeasuredChartFrame>
        </div>
      </div>
    </section>
  );
}

function SentenceStatRow({
  label,
  me,
  them,
  fmt,
}: {
  label: string;
  me: number;
  them: number;
  fmt: "int" | "dec0" | "dec1" | "dec2" | "pct";
}) {
  function f(v: number): string {
    switch (fmt) {
      case "int": return fmtInt(v);
      case "dec0": return v.toFixed(0);
      case "dec1": return v.toFixed(1);
      case "dec2": return v.toFixed(2);
      case "pct": return `${(v * 100).toFixed(1)}%`;
    }
  }
  return (
    <tr>
      <td>{label}</td>
      <td>
        <span style={{ color: "var(--me)", fontWeight: 600 }}>{f(me)}</span>
        <span className="hint" style={{ margin: "0 0.5rem" }}>vs</span>
        <span style={{ color: "var(--them)", fontWeight: 600 }}>{f(them)}</span>
      </td>
    </tr>
  );
}

// ----- 02: collocations -----

function CollocationsSection({
  colloc,
  metric,
  setMetric,
}: {
  colloc: { llr: CollocationRow[]; pmi: CollocationRow[]; tscore: CollocationRow[] };
  metric: Metric;
  setMetric: (m: Metric) => void;
}) {
  const rows = colloc[metric];
  const half = Math.ceil(rows.length / 2);
  const colA = rows.slice(0, half);
  const colB = rows.slice(half);
  const explanation: Record<Metric, string> = {
    llr: "Dunning's log-likelihood ratio — robust to low counts, tends to rank common-but-tight pairings.",
    pmi: "Pointwise mutual information — surfaces rare-but-exclusive pairings, often quirky names + idioms.",
    tscore: "Student's t-score — biased toward frequent pairings whose count exceeds chance.",
  };

  return (
    <section className="section">
      <h2><span className="num">02</span> Top collocations</h2>
      <div className="panel">
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: "0.7rem" }}>
          <div className="hint">Score:</div>
          <ButtonGroup
            options={[
              { v: "llr", label: "LLR" },
              { v: "pmi", label: "PMI" },
              { v: "tscore", label: "t-score" },
            ]}
            value={metric}
            onChange={(v) => setMetric(v as Metric)}
          />
          <div className="hint" style={{ fontStyle: "italic", flex: 1 }}>
            {explanation[metric]}
          </div>
        </div>
        <div className="row row-2">
          <CollocColumn rows={colA} metric={metric} />
          <CollocColumn rows={colB} metric={metric} />
        </div>
      </div>
    </section>
  );
}

function CollocColumn({ rows, metric }: { rows: CollocationRow[]; metric: Metric }) {
  return (
    <table className="kv-list" style={{ fontFamily: "var(--font-mono)" }}>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.gram}>
            <td style={{ width: "8%", color: "var(--ink-faded)", fontSize: "0.7rem" }}>
              {String(i + 1).padStart(2, "0")}
            </td>
            <td style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "var(--ink)", fontWeight: 500, width: "auto" }}>
              <PhraseLink gram={r.gram} />
            </td>
            <td style={{ textAlign: "right" }}>
              <span style={{ fontWeight: 600 }}>{formatScore(r.score, metric)}</span>{" "}
              <span className="hint" style={{ fontSize: "0.65rem" }}>n={fmtInt(r.n_count)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatScore(v: number, metric: Metric): string {
  if (metric === "llr") return v >= 1000 ? v.toFixed(0) : v.toFixed(1);
  if (metric === "pmi") return v.toFixed(2);
  return v.toFixed(2);
}

// ----- 03: distinctive phrases -----

type ScatterPoint = PhraseDivergence & { x: number; y: number };

function DistinctiveSection({
  divergence,
  divN,
  setDivN,
}: {
  divergence: Record<2 | 3, PhraseDivergence[]>;
  divN: N;
  setDivN: (n: N) => void;
}) {
  const rows = divergence[divN];

  const { points, meTop, themTop, labelSet } = useMemo(() => {
    const pts: ScatterPoint[] = rows.map((r) => ({
      ...r,
      x: Math.log10(Math.max(1, r.combined_count)),
      y: r.log_odds_z,
    }));
    const me = [...rows]
      .filter((r) => r.log_odds_z > 0)
      .sort((a, b) => b.log_odds_z - a.log_odds_z)
      .slice(0, 30);
    const them = [...rows]
      .filter((r) => r.log_odds_z < 0)
      .sort((a, b) => a.log_odds_z - b.log_odds_z)
      .slice(0, 30);
    const labels = new Set<string>([
      ...me.slice(0, 15).map((r) => r.gram),
      ...them.slice(0, 15).map((r) => r.gram),
    ]);
    return { points: pts, meTop: me, themTop: them, labelSet: labels };
  }, [rows]);

  const mePoints = points.filter((p) => p.y >= 0);
  const themPoints = points.filter((p) => p.y < 0);

  return (
    <section className="section">
      <h2><span className="num">03</span> Distinctive phrases</h2>
      <div className="panel">
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: "0.7rem" }}>
          <div className="hint">N-gram size:</div>
          <ButtonGroup
            options={[
              { v: "2", label: "Bigrams" },
              { v: "3", label: "Trigrams" },
            ]}
            value={String(divN)}
            onChange={(v) => setDivN(Number(v) as N)}
          />
          <div className="hint" style={{ fontStyle: "italic", flex: 1 }}>
            x = log<sub>10</sub>(combined count) &middot; y = z (Me&nbsp;&uarr; / Them&nbsp;&darr;)
          </div>
        </div>
        <MeasuredChartFrame height={460}>
          {({ width, height }) => (
            <ScatterChart width={width} height={height} margin={{ top: 16, right: 24, bottom: 36, left: 12 }}>
              <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="x"
                name="log10(count)"
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                domain={["dataMin - 0.1", "dataMax + 0.2"]}
                label={{
                  value: "log₁₀ combined count",
                  position: "insideBottom",
                  offset: -18,
                  style: { fontSize: 11, fill: "var(--ink-faded)" },
                }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="z-score"
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                label={{
                  value: "z (Me ↑ / Them ↓)",
                  angle: -90,
                  position: "insideLeft",
                  offset: 18,
                  style: { fontSize: 11, fill: "var(--ink-faded)", textAnchor: "middle" },
                }}
              />
              <ZAxis range={[24, 24]} />
              <ReferenceLine y={0} stroke="var(--ink-faded)" strokeWidth={1} />
              <ReferenceLine y={1.96} stroke="var(--ink-faded)" strokeDasharray="4 4" />
              <ReferenceLine y={-1.96} stroke="var(--ink-faded)" strokeDasharray="4 4" />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={({ active, payload }) => {
                  if (!active || !payload || !payload.length) return null;
                  const p = payload[0].payload as ScatterPoint;
                  return (
                    <div style={{ background: "var(--bg)", border: "1px solid var(--ink)", padding: "0.5rem 0.7rem", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{p.gram}</div>
                      <div>z = {p.log_odds_z.toFixed(2)}</div>
                      <div>combined = {fmtInt(p.combined_count)}</div>
                      <div style={{ color: "var(--me)" }}>Me: {fmtInt(p.count_me)}</div>
                      <div style={{ color: "var(--them)" }}>Them: {fmtInt(p.count_them)}</div>
                    </div>
                  );
                }}
              />
              <Scatter
                name="Me"
                data={mePoints}
                fill="var(--me)"
                fillOpacity={0.55}
                shape={(props: any) => <ScatterDot {...props} labelSet={labelSet} labelColor="var(--me)" />}
              />
              <Scatter
                name="Them"
                data={themPoints}
                fill="var(--them)"
                fillOpacity={0.55}
                shape={(props: any) => <ScatterDot {...props} labelSet={labelSet} labelColor="var(--them)" />}
              />
            </ScatterChart>
          )}
        </MeasuredChartFrame>
        <div className="hint" style={{ marginTop: "0.6rem" }}>
          Dashed horizontal lines mark z = ±1.96 (95% significance threshold).
        </div>
      </div>

      <div className="row row-2" style={{ marginTop: "1.5rem" }}>
        <DivergenceColumn title="Me-distinctive" accent="var(--me)" rows={meTop} sub="top 30 by z descending" />
        <DivergenceColumn title="Them-distinctive" accent="var(--them)" rows={themTop} sub="top 30 by z ascending" />
      </div>
    </section>
  );
}

function DivergenceColumn({
  title,
  accent,
  rows,
  sub,
}: {
  title: string;
  accent: string;
  rows: PhraseDivergence[];
  sub: string;
}) {
  return (
    <div className="panel">
      <div className="hint" style={{ marginBottom: "0.2rem", color: accent, fontWeight: 600 }}>
        {title.toUpperCase()}
      </div>
      <div className="hint" style={{ marginBottom: "0.7rem", fontStyle: "italic" }}>{sub}</div>
      <table className="kv-list" style={{ fontFamily: "var(--font-mono)" }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.gram}>
              <td style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--ink)", fontWeight: 500, width: "auto" }}>
                <PhraseLink gram={r.gram} />
              </td>
              <td style={{ width: "auto", textAlign: "right" }}>
                <span style={{ color: accent, fontWeight: 600 }}>
                  {r.log_odds_z >= 0 ? "+" : ""}
                  {r.log_odds_z.toFixed(2)}
                </span>{" "}
                <span className="hint" style={{ fontSize: "0.65rem" }}>
                  {fmtInt(r.combined_count)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScatterDot({
  cx,
  cy,
  payload,
  fill,
  labelSet,
  labelColor,
}: {
  cx?: number;
  cy?: number;
  payload?: ScatterPoint;
  fill?: string;
  labelSet: Set<string>;
  labelColor: string;
}) {
  if (cx == null || cy == null || !payload) return null;
  const labelled = labelSet.has(payload.gram);
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={labelled ? 3.5 : 2.5}
        fill={fill}
        stroke={labelled ? labelColor : "none"}
        strokeWidth={labelled ? 0.8 : 0}
      />
      {labelled && (
        <text x={cx + 6} y={cy + 3} fill={labelColor} fontSize={10} fontFamily="var(--font-mono)" fontWeight={600}>
          {payload.gram}
        </text>
      )}
    </g>
  );
}

// ----- 04: top phrases by raw count -----

function TopPhrasesSection({
  top,
  topN,
  setTopN,
}: {
  top: Record<2 | 3, Record<"all" | "me" | "them", TopPhraseRow[]>>;
  topN: N;
  setTopN: (n: N) => void;
}) {
  const rows = top[topN];

  return (
    <section className="section">
      <h2><span className="num">04</span> Top phrases by raw count</h2>
      <div className="panel">
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: "0.7rem" }}>
          <div className="hint">N-gram size:</div>
          <ButtonGroup
            options={[
              { v: "2", label: "Bigrams" },
              { v: "3", label: "Trigrams" },
            ]}
            value={String(topN)}
            onChange={(v) => setTopN(Number(v) as N)}
          />
          <div className="hint" style={{ fontStyle: "italic", flex: 1 }}>
            Most-frequent {topN === 2 ? "bigrams" : "trigrams"} (post stop-word filter).
          </div>
        </div>
        <div className="row row-3">
          <TopColumn title="Me" accent="var(--me)" rows={rows.me} />
          <TopColumn title="Them" accent="var(--them)" rows={rows.them} />
          <TopColumn title="Combined" accent="var(--ink)" rows={rows.all} />
        </div>
      </div>
    </section>
  );
}

function TopColumn({ title, accent, rows }: { title: string; accent: string; rows: TopPhraseRow[] }) {
  return (
    <div>
      <div className="hint" style={{ marginBottom: "0.6rem", color: accent, fontWeight: 600 }}>
        {title.toUpperCase()}
      </div>
      <table className="kv-list" style={{ fontFamily: "var(--font-mono)" }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.gram}>
              <td style={{ width: "12%", color: "var(--ink-faded)", fontSize: "0.65rem" }}>
                {String(i + 1).padStart(2, "0")}
              </td>
              <td style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--ink)", fontWeight: 500, width: "auto" }}>
                <PhraseLink gram={r.gram} />
              </td>
              <td style={{ textAlign: "right" }}>
                <span style={{ fontWeight: 600 }}>{fmtInt(r.n_count)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ----- helpers -----

function ButtonGroup({
  options,
  value,
  onChange,
}: {
  options: Array<{ v: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--ink)" }}>
      {options.map((o, i) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className="btn"
          style={{
            border: "none",
            borderRight: i < options.length - 1 ? "1px solid var(--ink)" : "none",
            background: o.v === value ? "var(--ink)" : "var(--bg)",
            color: o.v === value ? "var(--bg)" : "var(--ink)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PhraseLink({ gram }: { gram: string }) {
  return (
    <a className="phrase-evidence-link" href={evidenceHref({ label: gram, q: gram })}>
      {gram}
    </a>
  );
}

function MeasuredChartFrame({
  height,
  children,
}: {
  height: number;
  children: (size: { width: number; height: number }) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const next = Math.floor(node.getBoundingClientRect().width);
      if (next > 1) setWidth(next);
    };
    const frame = requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="phrase-measured-chart" style={{ height }}>
      {width > 1 ? children({ width, height }) : <div className="phrase-chart-placeholder" aria-hidden="true" />}
    </div>
  );
}
