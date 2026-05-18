import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getOpenLoops,
  type ClosureToken,
  type OpenLoop,
  type OpenLoopDay,
  type OpenLoopKind,
  type OpenLoopMonth,
  type LoopStatus,
} from "~/server/open-loop-queries";

export const Route = createFileRoute("/open-loops")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getOpenLoops({ data: deps }),
  component: OpenLoopsPage,
});

function OpenLoopsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxLoops = Math.max(...data.months.map((month) => month.loops), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Adjacency pairs</div>
        <PageTitleRow activePath="/open-loops" />
        <p className="page-lede">
          Questions, invitations, repairs, care checks, logistics, and small tasks create a
          conversational obligation. This view tracks whether the other person closes the loop,
          answers late, leaves it open, or the sender has to reopen it.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.real_messages,
            version: "open-loop-closure-v1",
            caveats: [
              "Temporal adjacency is used when explicit reply threading is unavailable.",
              "Kind order affects classification.",
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
        <Stat label="Loops detected" value={fmtInt(data.overview.loops)} note="questions, repairs, invites" />
        <Stat label="Closed" value={formatPct(data.overview.closure_rate)} note={`${fmtInt(data.overview.closed)} loops`} />
        <Stat label="Median close" value={formatDuration(data.overview.median_close_seconds)} note="closed loops only" />
        <Stat label="Most pressure" value={data.overview.most_open_kind} note={`${fmtInt(data.overview.delayed)} delayed · ${fmtInt(data.overview.reopened)} reopened · ${fmtInt(data.overview.open)} open`} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly loop pressure</h2>
        <div className="panel">
          <div className="hint open-loop-note">
            Pale bars are loop volume. Blue shows closed share; red marks delayed, open, or reopened pressure.
          </div>
          <div className="open-loop-strip-scroll">
            <div className="open-loop-strip-frame">
              <div className="open-loop-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(10px, 1fr))` }}>
                {data.months.map((month) => (
                  <MonthColumn key={month.ym} month={month} maxLoops={maxLoops} />
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
        <h2><span className="num">02</span> Loop types</h2>
        <div className="open-loop-kind-grid">
          {data.kinds.map((kind) => (
            <KindCard key={kind.kind} kind={kind} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> High-debt days</h2>
        <div className="open-loop-day-grid">
          {data.debt_days.map((day) => (
            <DebtDayCard key={day.ymd} day={day} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Closure language</h2>
        <div className="panel">
          <div className="open-loop-token-cloud">
            {data.closure_tokens.map((token) => (
              <ClosureTokenPill key={token.token} token={token} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">05</span> Examples</h2>
        <div className="open-loop-example-grid">
          {data.examples.map((loop) => (
            <LoopCard key={loop.id} loop={loop} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from{" "}
        {fmtInt(data.overview.real_messages)} real messages. Method: regex discourse-obligation taxonomy, first other-person reply within
        48 hours, closure scoring by answer markers and kind-specific language, and same-sender
        follow-up detection before closure.
      </p>
    </div>
  );
}

function MonthColumn({ month, maxLoops }: { month: OpenLoopMonth; maxLoops: number }) {
  const height = Math.max(4, (month.loops / maxLoops) * 100);
  const closedHeight = height * month.closure_rate;
  const debtHeight = height * ((month.open + month.reopened + month.delayed) / Math.max(month.loops, 1));
  return (
    <div className="open-loop-column" title={`${month.ym}: ${fmtInt(month.closed)} closed, ${fmtInt(month.open)} open`}>
      <span className="open-loop-volume-bar" style={{ height: `${height}%` }} />
      <span className="open-loop-closed-bar" style={{ height: `${closedHeight}%` }} />
      <span className="open-loop-debt-bar" style={{ height: `${debtHeight}%` }} />
    </div>
  );
}

function KindCard({ kind }: { kind: OpenLoopKind }) {
  const meShare = kind.loops ? kind.me_loops / kind.loops : 0;
  return (
    <article className="panel open-loop-kind-card">
      <div className="open-loop-kind-head">
        <div>
          <div className="turn-block-title">{kind.label}</div>
          <p>{kind.description}</p>
        </div>
        <div className="open-loop-count">{fmtInt(kind.loops)}</div>
      </div>
      <div className="open-loop-status-row">
        <StatusMeter label="Closed" value={kind.closure_rate} />
        <StatusMeter label="Pressure" value={(kind.open + kind.reopened + kind.delayed) / kind.loops} risk />
      </div>
      <div className="sender-split">
        <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
      </div>
      <div className="open-loop-meta">
        <span>Me {fmtInt(kind.me_loops)}</span>
        <span>Them {fmtInt(kind.them_loops)}</span>
        <span>close {formatDuration(kind.median_close_seconds)}</span>
        <span>{fmtInt(kind.reopened)} reopened</span>
      </div>
      <div className="open-loop-mini-list">
        {kind.examples.map((loop) => (
          <MiniLoop key={`${kind.kind}-${loop.id}`} loop={loop} />
        ))}
      </div>
    </article>
  );
}

function DebtDayCard({ day }: { day: OpenLoopDay }) {
  return (
    <article className="panel open-loop-day-card">
      <div className="open-loop-kind-head">
        <div>
          <div className="turn-block-title">{fmtDate(day.ts)}</div>
          <p>{fmtInt(day.loops)} loops · {fmtInt(day.delayed)} delayed · {fmtInt(day.reopened)} reopened · {fmtInt(day.open)} open</p>
        </div>
        <div className="open-loop-count risk">{day.debt_score.toFixed(1)}</div>
      </div>
      <div className="open-loop-mini-list">
        {day.examples.map((loop) => (
          <MiniLoop key={`${day.ymd}-${loop.id}`} loop={loop} />
        ))}
      </div>
      <div className="evidence-action-row">
        <EvidenceLink evidence={{ label: "Browse day", date: day.ymd, note: `${fmtInt(day.loops)} loop cues` }} />
      </div>
    </article>
  );
}

function LoopCard({ loop }: { loop: OpenLoop }) {
  return (
    <article className={`panel open-loop-example-card ${loop.status}`}>
      <div className="open-loop-example-head">
        <div>
          <StatusBadge status={loop.status} />
          <strong>{loop.sender} · {loop.label} · {fmtDate(loop.ts, { withTime: true })}</strong>
        </div>
        <span>{formatDuration(loop.reply_seconds)}</span>
      </div>
      <div className="open-loop-pair">
        <div>
          <strong>Loop</strong>
          <p>{loop.preview}</p>
          <EvidenceLink
            evidence={{
              label: "Open loop",
              date: loop.ymd,
              sender: loop.sender === "Me" ? "me" : "them",
              note: loop.label,
            }}
          />
        </div>
        {loop.reply_preview ? (
          <div>
            <strong>Reply</strong>
            <p>{loop.reply_preview}</p>
            <EvidenceLink
              evidence={{
                label: "Open reply",
                date: loop.reply_ymd ?? loop.ymd,
                sender: loop.sender === "Me" ? "them" : "me",
                note: formatDuration(loop.reply_seconds),
              }}
            />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function MiniLoop({ loop }: { loop: OpenLoop }) {
  return (
    <div className={`mini-loop ${loop.status}`}>
      <span>{loop.sender} · {fmtDate(loop.ts, { withTime: true })} · {loop.status}</span>
      <p>{loop.preview}</p>
      <EvidenceLink
        evidence={{
          label: "Browse",
          date: loop.ymd,
          sender: loop.sender === "Me" ? "me" : "them",
          note: loop.label,
        }}
      />
    </div>
  );
}

function ClosureTokenPill({ token }: { token: ClosureToken }) {
  const size = Math.min(1.4, 0.72 + Math.log1p(token.lift) * 0.22);
  return (
    <span style={{ fontSize: `${size}rem` }}>
      {token.token}
      <small>{token.lift.toFixed(1)}x</small>
    </span>
  );
}

function StatusMeter({ label, value, risk = false }: { label: string; value: number; risk?: boolean }) {
  return (
    <div className={risk ? "open-loop-meter risk" : "open-loop-meter"}>
      <span>{label}</span>
      <div><i style={{ width: `${Math.max(3, value * 100)}%` }} /></div>
      <strong>{formatPct(value)}</strong>
    </div>
  );
}

function StatusBadge({ status }: { status: LoopStatus }) {
  return <span className={`open-loop-badge ${status}`}>{status}</span>;
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

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
