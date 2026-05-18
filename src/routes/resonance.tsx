import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getResonance,
  type MoveKind,
  type ResonanceCell,
  type ResonanceExample,
  type ResonanceMonth,
  type ResonanceProfile,
} from "~/server/resonance-queries";

export const Route = createFileRoute("/resonance")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getResonance({ data: deps }),
  component: ResonancePage,
});

function ResonancePage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxPairs = Math.max(...data.months.map((month) => month.pairs), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Reply evocation</div>
        <PageTitleRow activePath="/resonance" />
        <p className="page-lede">
          What each kind of turn tends to call forth from the other person. Consecutive
          message bursts are collapsed into turns, adjacent replies are paired, and each
          source move is compared with the reply distribution it actually evokes.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: data.overview.reply_pairs,
            version: "resonance-reply-lift-v1",
            caveats: [
              "Move kinds use regex labels over collapsed turns.",
              "Sender filters apply to source turns while preserving opposite-person replies.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} source turns only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Reply pairs" value={fmtInt(data.overview.reply_pairs)} note={`${fmtInt(data.overview.turns)} turns`} />
        <Stat label="Median reply" value={fmtDuration(data.overview.median_reply_seconds)} note={`${formatPct(data.overview.fast_reply_rate)} within 1h`} />
        <Stat label="Mirror rate" value={formatPct(data.overview.mirror_rate)} note={`${formatPct(data.overview.avg_overlap)} lexical overlap`} />
        <Stat label="Strongest evocation" value={data.overview.strongest_evocation} note="lifted reply shape" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly resonance strip</h2>
        <div className="panel">
          <div className="hint resonance-note">
            Bars show paired reply volume by month. The red overlay is a compact resonance
            score from mirroring, fast replies, and lexical overlap.
          </div>
          <div className="resonance-strip-scroll">
            <div className="resonance-strip-frame">
              <div className="resonance-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(9px, 1fr))` }}>
                {data.months.map((month) => (
                  <MonthColumn key={month.ym} month={month} maxPairs={maxPairs} />
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
        <h2><span className="num">02</span> Response profiles</h2>
        <div className="resonance-profile-grid">
          {data.profiles.map((profile) => (
            <ProfileCard key={profile.key} profile={profile} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Lifted evocations</h2>
        <div className="resonance-cell-grid">
          {data.cells.map((cell) => (
            <CellCard key={cell.key} cell={cell} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real
        messages. Method: 20-minute same-sender turn collapse, 24-hour adjacent reply
        pairing, regex move taxonomy, reply-distribution lift, median latency, and
        stopword-filtered lexical overlap.
      </p>
    </div>
  );
}

function MonthColumn({ month, maxPairs }: { month: ResonanceMonth; maxPairs: number }) {
  const pairHeight = Math.max(3, (month.pairs / maxPairs) * 100);
  const scoreHeight = Math.max(2, Math.min(100, month.resonance_score * 100));
  return (
    <div className="resonance-column" title={`${month.ym}: ${month.pairs} reply pairs, mirror ${formatPct(month.mirror_rate)}, fast ${formatPct(month.fast_rate)}`}>
      <span className="resonance-pair-bar" style={{ height: `${pairHeight}%` }} />
      <span className="resonance-score-bar" style={{ height: `${scoreHeight}%` }} />
    </div>
  );
}

function ProfileCard({ profile }: { profile: ResonanceProfile }) {
  return (
    <article className="panel resonance-profile-card">
      <div className="resonance-profile-head">
        <div>
          <div className="turn-block-title">{profile.source_sender} {profile.source_label}</div>
          <p>answered by {profile.reply_sender}</p>
        </div>
        <div className="resonance-profile-count">{fmtInt(profile.total)}</div>
      </div>
      <div className="resonance-profile-metrics">
        <span>mirror {formatPct(profile.mirror_rate)}</span>
        <span>fast {formatPct(profile.fast_rate)}</span>
        <span>overlap {formatPct(profile.avg_overlap)}</span>
      </div>
      <div className="resonance-reply-list">
        {profile.top_replies.map((cell) => (
          <div className="resonance-reply-row" key={cell.key}>
            <MovePill kind={cell.reply_kind} label={cell.reply_label} />
            <span>{formatPct(cell.rate)} · {cell.lift.toFixed(1)}x</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function CellCard({ cell }: { cell: ResonanceCell }) {
  return (
    <article className="panel resonance-cell-card">
      <div className="resonance-path">
        <MovePill kind={cell.source_kind} label={`${cell.source_sender} ${cell.source_label}`} />
        <span>-&gt;</span>
        <MovePill kind={cell.reply_kind} label={`${cell.reply_sender} ${cell.reply_label}`} />
      </div>
      <div className="resonance-cell-score">{cell.lift.toFixed(2)}x</div>
      <div className="resonance-profile-metrics">
        <span>{fmtInt(cell.count)} / {fmtInt(cell.source_total)}</span>
        <span>{formatPct(cell.rate)} vs {formatPct(cell.expected_rate)}</span>
        <span>{fmtDuration(cell.median_reply_seconds)}</span>
        <span>overlap {formatPct(cell.avg_overlap)}</span>
      </div>
      {cell.examples.slice(0, 1).map((example, index) => (
        <ExamplePair key={`${cell.key}-${index}`} example={example} />
      ))}
    </article>
  );
}

function ExamplePair({ example }: { example: ResonanceExample }) {
  return (
    <div className="resonance-example-pair">
      <div>
        <strong>{example.source_sender} · {labelForKind(example.source_kind)} · {fmtDate(example.source_ts, { withTime: true })}</strong>
        <p>{example.source_text}</p>
        <EvidenceLink
          evidence={{
            label: "Browse source",
            date: example.source_ymd,
            sender: senderParam(example.source_sender),
            note: `${example.source_sender} ${labelForKind(example.source_kind)}`,
          }}
        />
      </div>
      <div>
        <strong>{example.reply_sender} · {labelForKind(example.reply_kind)} · {fmtDuration(example.reply_seconds)} later</strong>
        <p>{example.reply_text}</p>
        <EvidenceLink
          evidence={{
            label: "Browse reply",
            date: example.reply_ymd,
            sender: senderParam(example.reply_sender),
            note: `${example.reply_sender} ${labelForKind(example.reply_kind)}`,
          }}
        />
      </div>
    </div>
  );
}

function MovePill({ kind, label }: { kind: MoveKind; label: string }) {
  return <span className={`resonance-pill ${kind}`}>{label}</span>;
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

function labelForKind(kind: MoveKind) {
  return kind.slice(0, 1).toUpperCase() + kind.slice(1);
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function senderParam(sender: ResonanceExample["source_sender"]) {
  return sender === "Me" ? "me" as const : "them" as const;
}

function formatGeneratedAt(value: string) {
  return value.slice(0, 19).replace("T", " ");
}
