import { createFileRoute } from "@tanstack/react-router";
import { evidenceHref } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { PageTitleRow } from "~/components/PageTitleRow";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getEchoes,
  type EchoExample,
  type EchoMonth,
  type EchoMotif,
  type EchoReturn,
} from "~/server/echo-queries";

export const Route = createFileRoute("/echoes")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getEchoes({ data: deps }),
  component: EchoesPage,
});

function EchoesPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxReturns = Math.max(...data.months.map((month) => month.returns), 1);
  const maxGap = Math.max(...data.months.map((month) => month.max_gap_days), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Long-range recurrence</div>
        <PageTitleRow activePath="/echoes" />
        <p className="page-lede">
          Private language that goes quiet, then comes back. This view detects recurring phrases
          that return after 30+ dormant days and asks which ones become shared callbacks.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.scanned_messages,
            version: "echo-motif-v1",
            caveats: ["Curated motif filters exclude very common phrases and single-use echoes."],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Echo phrases" value={fmtInt(data.overview.echo_phrases)} note={`${fmtInt(data.overview.candidate_phrases)} candidates scanned`} />
        <Stat label="Dormant returns" value={fmtInt(data.overview.echo_returns)} note="after 30+ days quiet" />
        <Stat label="Shared returns" value={formatPct(data.overview.shared_echo_rate)} note="speaker changed across return" />
        <Stat label="Strongest echo" value={data.overview.strongest_phrase} note={`${fmtInt(Math.round(data.overview.longest_gap_days))}d longest gap`} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Return current</h2>
        <div className="panel">
          <div className="hint echo-note">
            Each month counts phrase returns after at least 30 dormant days. The dark pin marks the
            longest phrase gap that ended in that month.
          </div>
          <div className="echo-strip-scroll">
            <div className="echo-strip-frame">
              <div className="echo-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(9px, 1fr))` }}>
                {data.months.map((month) => (
                  <EchoMonthColumn key={month.ym} month={month} maxReturns={maxReturns} maxGap={maxGap} />
                ))}
              </div>
              <div className="restart-axis">
                <span>{data.months[0]?.ym}</span>
                <span>{data.months[data.months.length - 1]?.ym}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Resonant motifs</h2>
        <div className="echo-motif-grid">
          {data.motifs.map((motif) => (
            <MotifCard key={motif.phrase} motif={motif} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Longest callbacks</h2>
        <div className="echo-return-grid">
          {data.returns.map((item) => (
            <ReturnCard key={`${item.phrase}-${item.to_ts}-${item.from_ts}`} item={item} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Cross-person echoes</h2>
        <div className="echo-handoff-grid">
          {data.handoffs.map((item) => (
            <ReturnCard key={`handoff-${item.phrase}-${item.to_ts}-${item.from_ts}`} item={item} compact />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from{" "}
        {fmtInt(data.overview.scanned_messages)} real messages. Method: filtered 2-4 word motifs,
        minimum 5 uses across 3 days and 2 months, with dormant returns after 30+ days.
      </p>
    </div>
  );
}

function EchoMonthColumn({ month, maxReturns, maxGap }: { month: EchoMonth; maxReturns: number; maxGap: number }) {
  const height = Math.max(4, (month.returns / maxReturns) * 100);
  const sharedHeight = Math.max(0, (month.shared_returns / Math.max(1, month.returns)) * height);
  const pinHeight = Math.max(4, (month.max_gap_days / maxGap) * 100);
  return (
    <div className="echo-column" title={`${month.ym}: ${fmtInt(month.returns)} returns`}>
      <div className="echo-return-bar" style={{ height: `${height}%` }} />
      <div className="echo-shared-bar" style={{ height: `${sharedHeight}%` }} />
      <div className="echo-gap-pin" style={{ bottom: `${pinHeight}%` }} />
    </div>
  );
}

function MotifCard({ motif }: { motif: EchoMotif }) {
  return (
    <article className="panel echo-motif-card">
      <div className="echo-motif-head">
        <div>
          <div className="echo-phrase">&quot;{motif.phrase}&quot;</div>
          <div className="echo-score">{motif.score.toFixed(2)}</div>
        </div>
        <div className="echo-gap">
          {fmtInt(Math.round(motif.max_gap_days))}d
          <span>longest quiet</span>
        </div>
      </div>
      <div className="echo-meta">
        <span>{fmtInt(motif.count)} uses</span>
        <span>{fmtInt(motif.days)} days</span>
        <span>{fmtInt(motif.months)} months</span>
        <span>{fmtInt(motif.return_count)} returns</span>
      </div>
      <div className="echo-evidence-row">
        <PhraseEvidenceLink phrase={motif.phrase} label="Browse motif" />
      </div>
      <div className="sender-split" title={`Me ${fmtInt(motif.me_count)} / Them ${fmtInt(motif.them_count)}`}>
        <div className="sender-split-me" style={{ width: `${motif.count ? (motif.me_count / motif.count) * 100 : 0}%` }} />
      </div>
      <div className="echo-scale">
        <span>sharedness</span>
        <strong>{formatPct(motif.sharedness)}</strong>
        <span>handoffs</span>
        <strong>{fmtInt(motif.sender_switches)}</strong>
      </div>
      <div className="echo-examples">
        {motif.examples.map((example) => (
          <EchoExampleLine key={`${motif.phrase}-${example.role}-${example.ts}`} phrase={motif.phrase} example={example} />
        ))}
      </div>
    </article>
  );
}

function ReturnCard({ item, compact = false }: { item: EchoReturn; compact?: boolean }) {
  return (
    <article className={compact ? "panel echo-return-card compact" : "panel echo-return-card"}>
      <div className="echo-return-head">
        <div>
          <div className="echo-phrase">&quot;{item.phrase}&quot;</div>
          <div className="echo-score">{fmtInt(Math.round(item.gap_days))}d</div>
        </div>
        <div className={item.previous_sender === item.return_sender ? "echo-path" : "echo-path switched"}>
          <span>{item.previous_sender}</span>
          <b>-&gt;</b>
          <span>{item.return_sender}</span>
        </div>
      </div>
      <div className="echo-meta">
        <span>{fmtDate(item.from_ts, { withTime: true })}</span>
        <span>{fmtDate(item.to_ts, { withTime: true })}</span>
      </div>
      <div className="echo-return-pair">
        <div>
          <strong>Before</strong>
          <p>{item.before_preview}</p>
          <PhraseEvidenceLink phrase={item.phrase} label="Open before" date={item.from_ymd} sender={item.previous_sender} />
        </div>
        {!compact ? (
          <div>
            <strong>Return</strong>
            <p>{item.return_preview}</p>
            <PhraseEvidenceLink phrase={item.phrase} label="Open return" date={item.to_ymd} sender={item.return_sender} />
          </div>
        ) : (
          <div className="echo-evidence-row">
            <PhraseEvidenceLink phrase={item.phrase} label="Open return" date={item.to_ymd} sender={item.return_sender} />
          </div>
        )}
      </div>
    </article>
  );
}

function EchoExampleLine({ phrase, example }: { phrase: string; example: EchoExample }) {
  return (
    <div className={`echo-example ${example.role}`}>
      <span>{example.role} · {example.sender} · {fmtDate(example.ts, { withTime: true })}</span>
      <p>{example.preview}</p>
      <PhraseEvidenceLink phrase={phrase} label={`Open ${example.role}`} date={example.ymd} sender={example.sender} />
    </div>
  );
}

function PhraseEvidenceLink({
  phrase,
  label,
  date,
  sender,
}: {
  phrase: string;
  label: string;
  date?: string;
  sender?: "Me" | "Them";
}) {
  return (
    <a
      className="evidence-link echo-evidence-link"
      href={evidenceHref({ label, q: phrase, date, sender: sender === "Me" ? "me" : sender === "Them" ? "them" : undefined })}
    >
      <span>{label}</span>
      <small>{phrase}</small>
    </a>
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

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
