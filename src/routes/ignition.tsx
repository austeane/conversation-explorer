import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getIgnition,
  type IgnitionAttempt,
  type IgnitionKind,
  type IgnitionMonth,
} from "~/server/ignition-queries";

export const Route = createFileRoute("/ignition")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getIgnition({ data: deps }),
  component: IgnitionPage,
});

function IgnitionPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxAttempts = Math.max(...data.months.map((month) => month.attempts), 1);
  const maxScore = Math.max(...data.months.map((month) => month.max_score), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Restart mechanics</div>
        <PageTitleRow activePath="/ignition" />
        <p className="page-lede">
          First messages after 6+ hours of silence, scored by whether they pull the thread into a
          live exchange. This asks which opening moves actually restart momentum.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: data.overview.attempts,
            version: "ignition-restart-v1",
            caveats: [
              "Hard thresholds define ignitions.",
              "Sender filters apply to silence-breaking openers while preserving follow-on replies.",
            ],
          }}
          confidence="medium"
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} openers only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Restart attempts" value={fmtInt(data.overview.attempts)} note="after 6h+ silence" />
        <Stat label="Ignitions" value={fmtInt(data.overview.ignitions)} note={formatPct(data.overview.ignition_rate)} />
        <Stat label="Median reply" value={formatDuration(data.overview.median_reply_seconds)} note="when a reply landed within 24h" />
        <Stat label="Strongest opener" value={data.overview.strongest_kind} note={formatPct(data.overview.strongest_kind_rate)} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly sparkline</h2>
        <div className="panel">
          <div className="hint ignition-note">
            Tall bars mean more restart attempts; the red fill shows the share that turned into an
            ignition. Dark pins mark the strongest single restart score in that month.
          </div>
          <div className="ignition-strip-scroll">
            <div className="ignition-strip-frame">
              <div className="ignition-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(10px, 1fr))` }}>
                {data.months.map((month) => (
                  <MonthColumn key={month.ym} month={month} maxAttempts={maxAttempts} maxScore={maxScore} />
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
        <h2><span className="num">02</span> Opener grammar</h2>
        <div className="ignition-kind-grid">
          {data.kinds.map((kind) => (
            <KindCard key={kind.key} kind={kind} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Highest ignition starts</h2>
        <div className="ignition-attempt-grid">
          {data.top_attempts.map((attempt) => (
            <AttemptCard key={attempt.id} attempt={attempt} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Long-silence misses</h2>
        <div className="ignition-miss-grid">
          {data.quiet_misses.map((attempt) => (
            <AttemptCard key={attempt.id} attempt={attempt} compact />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real messages.
        Method: first real message after 6+ hours of silence; ignition requires a next-person reply plus
        enough four-hour or twenty-four-hour follow-on volume.
      </p>
    </div>
  );
}

function MonthColumn({ month, maxAttempts, maxScore }: { month: IgnitionMonth; maxAttempts: number; maxScore: number }) {
  const height = Math.max(4, (month.attempts / maxAttempts) * 100);
  const ignitedHeight = Math.max(0, month.ignition_rate * height);
  const pinHeight = Math.max(4, (month.max_score / maxScore) * 100);
  return (
    <div
      className="ignition-column"
      title={`${month.ym}: ${fmtInt(month.ignitions)} / ${fmtInt(month.attempts)} ignited`}
    >
      <div className="ignition-attempt-bar" style={{ height: `${height}%` }} />
      <div className="ignition-rate-bar" style={{ height: `${ignitedHeight}%` }} />
      <div className="ignition-score-pin" style={{ bottom: `${pinHeight}%` }} />
    </div>
  );
}

function KindCard({ kind }: { kind: IgnitionKind }) {
  const meShare = kind.attempts ? kind.me_attempts / kind.attempts : 0;
  return (
    <article className="panel ignition-kind-card">
      <div className="ignition-kind-head">
        <div>
          <div className="turn-block-title">{kind.label}</div>
          <div className="ignition-rate">{formatPct(kind.ignition_rate)}</div>
        </div>
        <div className="ignition-count">
          {fmtInt(kind.ignitions)}
          <span>of {fmtInt(kind.attempts)}</span>
        </div>
      </div>
      <p>{kind.description}</p>
      <div className="sender-split">
        <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
      </div>
      <div className="ignition-meta">
        <span>Me {fmtInt(kind.me_attempts)}</span>
        <span>Them {fmtInt(kind.them_attempts)}</span>
        <span>reply {formatDuration(kind.median_reply_seconds)}</span>
        <span>4h median {fmtInt(Math.round(kind.median_messages_4h))} msgs</span>
      </div>
      <div className="ignition-kind-examples">
        {kind.examples.map((attempt) => (
          <MiniAttempt key={`${kind.key}-${attempt.id}`} attempt={attempt} />
        ))}
      </div>
    </article>
  );
}

function AttemptCard({ attempt, compact = false }: { attempt: IgnitionAttempt; compact?: boolean }) {
  return (
    <article className={compact ? "panel ignition-attempt-card compact" : "panel ignition-attempt-card"}>
      <div className="ignition-attempt-head">
        <div>
          <div className="turn-block-title">{attempt.label}</div>
          <div className={attempt.ignited ? "ignition-score ignited" : "ignition-score"}>{attempt.score.toFixed(2)}</div>
        </div>
        <div className={attempt.sender === "Me" ? "sender-badge me" : "sender-badge them"}>
          <span>{attempt.sender}</span>
          <small>{fmtDate(attempt.ts, { withTime: true })}</small>
        </div>
      </div>
      <div className="ignition-meta">
        <span>gap {fmtDuration(attempt.gap_seconds)}</span>
        <span>reply {formatDuration(attempt.reply_seconds)}</span>
        <span>{fmtInt(attempt.messages_4h)} msgs / 4h</span>
        <span>{fmtInt(attempt.messages_24h)} msgs / 24h</span>
      </div>
      <div className="ignition-preview">
        <strong>Opener</strong>
        <p>{attempt.preview}</p>
        <EvidenceLink
          evidence={{
            label: "Browse opener",
            date: attempt.ymd,
            sender: senderParam(attempt.sender),
            note: `${attempt.sender} ${attempt.label}`,
          }}
        />
      </div>
      {!compact && attempt.reply_preview ? (
        <div className="ignition-preview reply">
          <strong>First reply</strong>
          <p>{attempt.reply_preview}</p>
          {attempt.reply_ymd && attempt.reply_sender && (
            <EvidenceLink
              evidence={{
                label: "Browse reply",
                date: attempt.reply_ymd,
                sender: senderParam(attempt.reply_sender),
                note: `${attempt.reply_sender} first reply`,
              }}
            />
          )}
        </div>
      ) : null}
    </article>
  );
}

function MiniAttempt({ attempt }: { attempt: IgnitionAttempt }) {
  return (
    <div className={attempt.ignited ? "mini-attempt ignited" : "mini-attempt"}>
      <span>{attempt.sender} · {fmtDate(attempt.ts, { withTime: true })}</span>
      <p>{attempt.preview}</p>
      <EvidenceLink
        evidence={{
          label: "Browse opener",
          date: attempt.ymd,
          sender: senderParam(attempt.sender),
          note: attempt.label,
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

function formatPct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(value: number | null) {
  return value == null ? "n/a" : fmtDuration(value);
}

function senderParam(sender: "Me" | "Them") {
  return sender === "Me" ? "me" : "them";
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
