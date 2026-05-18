import { createFileRoute } from "@tanstack/react-router";
import { evidenceHref } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { PageTitleRow } from "~/components/PageTitleRow";
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getEntrainment,
  type AdoptionWord,
  type LexicalSimilarity,
  type SharedWord,
  type SignatureWord,
} from "~/server/entrainment-queries";
import { type ReactNode, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/entrainment")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) =>
    getEntrainment({
      data: { from: deps.from, to: deps.to, phase: deps.phase, sender: "both" },
    }),
  component: EntrainmentPage,
});

function EntrainmentPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasDateFilters = Boolean(search.from || search.to || search.phase != null);
  const ignoredSender = Boolean(search.sender && search.sender !== "both");

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Lexical entrainment</div>
        <PageTitleRow activePath="/entrainment" />
        <p className="page-lede">
          A vocabulary convergence view: how similar Me and Them's monthly word
          distributions become, which words each person tends to own, and which terms crossed
          from one person into the shared lexicon.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: data.me_tokens + data.them_tokens,
            version: "entrainment-v2-shared-tokenizer",
            caveats: ["Monthly cosine and adoption lag are descriptive, not causal."],
          }}
          confidence="medium"
        />
        {(hasDateFilters || ignoredSender) && (
          <p className="browse-filter-note">
            {hasDateFilters ? <>Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}.</> : null}
            {ignoredSender ? <> Shared-language analysis compares both senders; sender filter is not applied.</> : null}
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Months analyzed" value={fmtInt(data.months_analyzed)} note="with enough words from both people" />
        <Stat label="Median similarity" value={data.median_cosine.toFixed(2)} note="monthly cosine over content words" />
        <Stat label="Shared words" value={fmtInt(data.shared_word_count)} note="20+ uses by both, balanced" />
        <Stat label="Analyzed words" value={fmtInt(data.me_tokens + data.them_tokens)} note={`${fmtInt(data.me_tokens)} Me · ${fmtInt(data.them_tokens)} Them`} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Convergence over time</h2>
        <div className="panel">
          <div className="hint dynamics-note">
            Cosine similarity between Me's and Them's content-word distributions in each
            month. Higher means the same vocabulary is doing more work for both people.
          </div>
          <MeasuredChartFrame className="turn-chart" height={320}>
            {({ width, height }) => (
              <LineChart width={width} height={height} data={data.monthly} margin={{ top: 10, right: 18, bottom: 24, left: -8 }}>
                <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" />
                <XAxis dataKey="ym" tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }} interval={5} />
                <YAxis
                  domain={[0, 1]}
                  tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                  tickFormatter={(v: number) => v.toFixed(1)}
                />
                <Tooltip content={<SimilarityTooltip />} />
                <Line type="monotone" dataKey="cosine" stroke="var(--accent)" dot={false} strokeWidth={2} />
              </LineChart>
            )}
          </MeasuredChartFrame>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Words that crossed over</h2>
        <div className="row row-2">
          <AdoptionColumn title="Me first, Them later" words={data.me_first} accent="var(--me)" />
          <AdoptionColumn title="Them first, Me later" words={data.them_first} accent="var(--them)" />
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Shared core lexicon</h2>
        <div className="panel">
          <div className="shared-word-grid">
            {data.shared_words.map((word) => (
              <SharedWordChip key={word.word} word={word} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Directional word signatures</h2>
        <div className="row row-2">
          <SignatureColumn title="More Me" words={data.me_signature} accent="var(--me)" />
          <SignatureColumn title="More Them" words={data.them_signature} accent="var(--them)" />
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.generated_at)} from scoped real message text.
        Shared stopwords, URLs, tapbacks, and very short tokens are excluded.
      </p>
    </div>
  );
}

function AdoptionColumn({ title, words, accent }: { title: string; words: AdoptionWord[]; accent: string }) {
  return (
    <div className="panel">
      <div className="hint entrainment-title" style={{ color: accent }}>{title.toUpperCase()}</div>
      <table className="turn-table">
        <tbody>
          {words.slice(0, 18).map((word) => (
            <tr key={word.word}>
              <td className="entrainment-word"><WordEvidenceLink word={word.word} /></td>
              <td>{word.first_source_ym} to {word.first_adopter_ym}</td>
              <td>{fmtInt(word.lag_months)} mo</td>
              <td>{fmtInt(word.adopter_count_after)} later uses</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignatureColumn({ title, words, accent }: { title: string; words: SignatureWord[]; accent: string }) {
  return (
    <div className="panel">
      <div className="hint entrainment-title" style={{ color: accent }}>{title.toUpperCase()}</div>
      <table className="turn-table">
        <tbody>
          {words.map((word) => (
            <tr key={word.word}>
              <td className="entrainment-word">
                <WordEvidenceLink word={word.word} sender={title === "More Me" ? "me" : "them"} />
              </td>
              <td>{fmtInt(word.me_count)}</td>
              <td>{fmtInt(word.them_count)}</td>
              <td>{word.z.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SharedWordChip({ word }: { word: SharedWord }) {
  return (
    <a className="shared-word-chip" href={evidenceHref({ label: word.word, q: word.word })}>
      <strong>{word.word}</strong>
      <span>{fmtInt(word.total)} total</span>
      <small>{fmtInt(word.me_count)} / {fmtInt(word.them_count)}</small>
    </a>
  );
}

function SimilarityTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as LexicalSimilarity;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{label}</div>
      <div>similarity {row.cosine.toFixed(3)}</div>
      <div>Me {fmtInt(row.me_tokens)} words</div>
      <div>Them {fmtInt(row.them_tokens)} words</div>
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

function WordEvidenceLink({ word, sender }: { word: string; sender?: "me" | "them" }) {
  return (
    <a className="entrainment-word-link" href={evidenceHref({ label: word, q: word, sender })}>
      {word}
    </a>
  );
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}

function MeasuredChartFrame({
  className,
  height,
  children,
}: {
  className: string;
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
    <div ref={ref} className={className} style={{ height }}>
      {width > 1 ? children({ width, height }) : <div className="phrase-chart-placeholder" aria-hidden="true" />}
    </div>
  );
}
