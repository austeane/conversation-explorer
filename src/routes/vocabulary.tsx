import { createFileRoute } from "@tanstack/react-router";
import { evidenceHref } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { PageTitleRow } from "~/components/PageTitleRow";
import {
  getIconicWords,
  getWordDivergence,
  type IconicWord,
  type WordDivergence,
} from "~/server/queries";
import { fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import { useMemo } from "react";

export const Route = createFileRoute("/vocabulary")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const scope = { from: deps.from, to: deps.to, phase: deps.phase, sender: "both" as const };
    // Pull divergence and iconic in parallel. Both server fns share the same
    // tokenization but iconic applies different filters (lift floor + |z| ceiling).
    const [divergence, iconic] = await Promise.all([
      getWordDivergence({ data: scope }),
      // Default thresholds: ≥10× baseline (minIconicScore=1.0) and |z| ≤ 1.5.
      getIconicWords({ data: scope }),
    ]);
    return { divergence, iconic };
  },
  component: VocabularyPage,
});

type ScatterPoint = WordDivergence & { x: number; y: number };

function VocabularyPage() {
  const { divergence, iconic } = Route.useLoaderData();
  const search = Route.useSearch();
  const hasDateFilters = Boolean(search.from || search.to || search.phase != null);
  const ignoredSender = Boolean(search.sender && search.sender !== "both");
  const sampleCount = divergence.reduce((sum, word) => sum + word.combined_count, 0);

  const { points, meTop, themTop, iconicTop, labelSet } = useMemo(() => {
    const pts: ScatterPoint[] = divergence.map((w) => ({
      ...w,
      x: Math.log10(Math.max(1, w.combined_count)),
      y: w.log_odds_z,
    }));

    // top 30 Me-distinctive (z descending)
    const me = [...divergence]
      .filter((w) => w.log_odds_z > 0)
      .sort((a, b) => b.log_odds_z - a.log_odds_z)
      .slice(0, 30);

    // top 30 Them-distinctive (z ascending, most negative first)
    const them = [...divergence]
      .filter((w) => w.log_odds_z < 0)
      .sort((a, b) => a.log_odds_z - b.log_odds_z)
      .slice(0, 30);

    // Iconic = words BOTH of us use ≥10× more than average English speakers,
    // with similar usage rates between us. Server has already filtered/sorted
    // by iconic_score descending; we just take the head.
    const iconicHead = iconic.slice(0, 30);

    // top 15 by |z| in each direction → labelled in scatter
    const labels = new Set<string>([
      ...me.slice(0, 15).map((w) => w.word),
      ...them.slice(0, 15).map((w) => w.word),
    ]);

    return {
      points: pts,
      meTop: me,
      themTop: them,
      iconicTop: iconicHead,
      labelSet: labels,
    };
  }, [divergence, iconic]);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Distinctive vocabulary</div>
        <PageTitleRow activePath="/vocabulary" />
        <p className="page-lede">
          Which words does each person use <em>distinctively</em>, controlling for shared baseline
          frequency? This uses Monroe, Colaresi &amp; Quinn (2008): log-odds ratio with an
          informative Dirichlet prior, then z-scoring. Words with |z| &gt; 1.96 differ at
          roughly 95% significance.
        </p>
        <p className="hint" style={{ marginTop: "0.5rem" }}>
          <strong>Iconic</strong> = words we both use ≥10× more than average English (via{" "}
          <code>wordfreq</code> baseline). <strong>Distinctive</strong> = log-odds Me-vs-Them
          with Dirichlet prior (Monroe et al. 2008).
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: sampleCount,
            version: "mcq-log-odds-v1",
            caveats: [
              "Vocabulary compares both senders even when a sender filter is present.",
              "Baseline lift can overstate unknown or rare English words.",
            ],
          }}
        />
        {(hasDateFilters || ignoredSender) && (
          <p className="browse-filter-note">
            {hasDateFilters ? <>Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}.</> : null}
            {ignoredSender ? <> Vocabulary compares both senders; sender filter is not applied.</> : null}
          </p>
        )}
      </div>

      {divergence.length === 0 ? (
        <section className="section">
          <div className="panel">
            <p className="hint">No two-sided vocabulary sample matches the current date range.</p>
          </div>
        </section>
      ) : (
      <section className="section">
        <h2><span className="num">01</span> Word-frequency vs. distinctiveness</h2>
        <div className="panel">
          <div className="hint" style={{ marginBottom: "0.6rem" }}>
            x = log<sub>10</sub>(combined count) &middot; y = z-score &middot;{" "}
            <span style={{ color: "var(--me)", fontWeight: 600 }}>blue</span> = Me,{" "}
            <span style={{ color: "var(--them)", fontWeight: 600 }}>red</span> = Them. Top-15 by
            |z| in each direction labelled.
          </div>
          <VocabularyScatter points={points} labelSet={labelSet} />
          <div className="hint" style={{ marginTop: "0.6rem" }}>
            Dashed horizontal lines mark z = ±1.96 (95% significance threshold).
          </div>
        </div>
      </section>
      )}

      <section className="section">
        <h2><span className="num">02</span> Ranked words</h2>
        <div className="row row-3">
          <RankColumn
            title="Me-distinctive"
            accent="var(--me)"
            words={meTop}
            metric="z"
            sub="top 30 by z descending"
          />
          <IconicColumn words={iconicTop} />
          <RankColumn
            title="Them-distinctive"
            accent="var(--them)"
            words={themTop}
            metric="z"
            sub="top 30 by z ascending"
          />
        </div>
      </section>

      <p className="hint" style={{ marginTop: "3rem", textAlign: "center" }}>
        {fmtInt(divergence.length)} words in scatter; top 1000 by |z|, top 200 by combined count,
        top 300 by iconic-score (combined ≥ 10). Iconic candidates: {fmtInt(iconic.length)}.
        Methods: Monroe, Colaresi &amp; Quinn 2008 (distinctive); <code>wordfreq</code> baseline lift (iconic).
      </p>
    </div>
  );
}

function VocabularyScatter({ points, labelSet }: { points: ScatterPoint[]; labelSet: Set<string> }) {
  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const yAbs = Math.max(...points.map((point) => Math.abs(point.y)), 2.2);
  const yMax = Math.ceil(yAbs);
  const xTicks = ticks(xMin, xMax, 5);
  const yTicks = [-1.96, 0, 1.96].filter((tick) => Math.abs(tick) <= yMax);

  return (
    <div className="vocab-chart-frame">
      <svg className="vocab-chart-svg" viewBox="0 0 1000 520" role="img" aria-label="Word frequency and distinctiveness scatterplot">
        {xTicks.map((tick) => {
          const x = vocabX(tick, xMin, xMax);
          const xCoord = svgCoord(x);
          return (
            <g key={`x-${tick}`}>
              <line className="vocab-grid-line" x1={xCoord} x2={xCoord} y1="24" y2="470" />
              <text className="vocab-axis-label" x={xCoord} y="500" textAnchor="middle">{tick.toFixed(1)}</text>
            </g>
          );
        })}
        {yTicks.map((tick) => {
          const y = vocabY(tick, yMax);
          const yCoord = svgCoord(y);
          return (
            <g key={`y-${tick}`}>
              <line className={tick === 0 ? "vocab-zero-line" : "vocab-grid-line important"} x1="64" x2="972" y1={yCoord} y2={yCoord} />
              <text className="vocab-axis-label" x="48" y={svgCoord(y + 4)} textAnchor="end">{tick.toFixed(tick === 0 ? 0 : 2)}</text>
            </g>
          );
        })}
        <text className="vocab-axis-title" x="518" y="516" textAnchor="middle">log10 combined count</text>
        <text className="vocab-axis-title" x="18" y="250" textAnchor="middle" transform="rotate(-90 18 250)">z-score</text>
        {points.map((point) => (
          <VocabularyPoint
            key={point.word}
            point={point}
            x={vocabX(point.x, xMin, xMax)}
            y={vocabY(point.y, yMax)}
            labelled={labelSet.has(point.word)}
          />
        ))}
      </svg>
    </div>
  );
}

function VocabularyPoint({ point, x, y, labelled }: { point: ScatterPoint; x: number; y: number; labelled: boolean }) {
  const side = point.y >= 0 ? "me" : "them";
  const xCoord = svgCoord(x);
  const yCoord = svgCoord(y);
  return (
    <g className={labelled ? `vocab-point labelled ${side}` : `vocab-point ${side}`}>
      <circle cx={xCoord} cy={yCoord} r={labelled ? 4 : 2.8}>
        <title>{`${point.word}: z ${point.log_odds_z.toFixed(2)}, combined ${fmtInt(point.combined_count)}, Me ${fmtInt(point.count_me)}, Them ${fmtInt(point.count_them)}`}</title>
      </circle>
      {labelled && (
        <text x={svgCoord(x + 7)} y={svgCoord(y + 3)}>{point.word}</text>
      )}
    </g>
  );
}

function vocabX(value: number, min: number, max: number) {
  return 64 + ((value - min) / Math.max(max - min, 0.001)) * 908;
}

function vocabY(value: number, yMax: number) {
  return 247 - (value / Math.max(yMax, 1)) * 223;
}

function svgCoord(value: number) {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function ticks(min: number, max: number, count: number) {
  if (max <= min) return [min];
  const step = (max - min) / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
}

function RankColumn({
  title,
  accent,
  words,
  metric,
  sub,
}: {
  title: string;
  accent: string;
  words: WordDivergence[];
  metric: "z" | "combined";
  sub: string;
}) {
  return (
    <div className="panel">
      <div
        className="hint"
        style={{ marginBottom: "0.2rem", color: accent, fontWeight: 600 }}
      >
        {title.toUpperCase()}
      </div>
      <div className="hint" style={{ marginBottom: "0.7rem", fontStyle: "italic" }}>
        {sub}
      </div>
      <table className="kv-list" style={{ fontFamily: "var(--font-mono)" }}>
        <tbody>
          {words.map((w) => (
            <tr key={w.word}>
              <td style={{ textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-mono)", fontSize: "0.82rem", color: "var(--ink)", fontWeight: 500, width: "auto" }}>
                <a className="phrase-evidence-link" href={evidenceHref({ label: w.word, q: w.word })}>
                  {w.word}
                </a>
              </td>
              <td style={{ width: "auto", textAlign: "right" }}>
                {metric === "z" ? (
                  <>
                    <span style={{ color: accent, fontWeight: 600 }}>
                      {w.log_odds_z >= 0 ? "+" : ""}
                      {w.log_odds_z.toFixed(2)}
                    </span>{" "}
                    <span className="hint" style={{ fontSize: "0.75rem" }}>
                      {fmtInt(w.combined_count)}
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ fontWeight: 600 }}>{fmtInt(w.combined_count)}</span>{" "}
                    <span className="hint" style={{ fontSize: "0.75rem" }}>
                      z={w.log_odds_z >= 0 ? "+" : ""}
                      {w.log_odds_z.toFixed(2)}
                    </span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Iconic column: words BOTH of us use far above baseline English. The header metric is
// "×lift" = 10^iconic_score, the smaller of (Me lift, Them lift). The native
// HTML title attribute carries baseline Zipf for hover-inspection (no JS tooltip
// state to manage).
function IconicColumn({ words }: { words: IconicWord[] }) {
  return (
    <div className="panel">
      <div
        className="hint"
        style={{ marginBottom: "0.2rem", color: "var(--ink)", fontWeight: 600 }}
      >
        ICONIC TO US
      </div>
      <div className="hint" style={{ marginBottom: "0.7rem", fontStyle: "italic" }}>
        words we both use far more than average English
      </div>
      {words.length === 0 ? (
        <div className="hint" style={{ padding: "1rem 0" }}>
          No iconic words found; baseline data may be missing.
          Run <code>scripts/build-baseline.py</code>.
        </div>
      ) : (
        <table className="kv-list" style={{ fontFamily: "var(--font-mono)" }}>
          <tbody>
            {words.map((w) => {
              const lift = Math.pow(10, w.iconic_score); // = min(lift_me, lift_them)
              const liftLabel = lift >= 100 ? `×${Math.round(lift)}` : `×${lift.toFixed(1)}`;
              const baselineNote =
                w.baseline_zipf <= 1.0
                  ? `zipf ${w.baseline_zipf.toFixed(2)} (off-baseline)`
                  : `zipf ${w.baseline_zipf.toFixed(2)}`;
              return (
                <tr
                  key={w.word}
                  title={`${w.word}: Me ${fmtInt(w.count_me)} (x${w.lift_me.toFixed(1)}), Them ${fmtInt(w.count_them)} (x${w.lift_them.toFixed(1)}), baseline ${baselineNote}`}
                >
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
                    <a className="phrase-evidence-link" href={evidenceHref({ label: w.word, q: w.word })}>
                      {w.word}
                    </a>
                  </td>
                  <td style={{ width: "auto", textAlign: "right" }}>
                    <span style={{ fontWeight: 600 }}>{liftLabel}</span>{" "}
                    <span className="hint" style={{ fontSize: "0.75rem" }}>
                      n={fmtInt(w.combined_count)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
