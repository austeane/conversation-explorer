import { createFileRoute } from "@tanstack/react-router";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { PageTitleRow } from "~/components/PageTitleRow";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getDesireSessions,
  type DesireBackAndForthSession,
  type DesireSnippet,
} from "~/server/desire-queries";

export const Route = createFileRoute("/desire-sessions")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getDesireSessions({ data: deps }),
  component: DesireSessionsPage,
});

function DesireSessionsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxDistribution = Math.max(1, ...data.distribution.map((item) => item.sessions));

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Intimacy channel</div>
        <PageTitleRow activePath="/desire-sessions" />
        <p className="page-lede">
          The horny-session view groups sexual-scored messages into continuous episodes, then ranks
          the sessions by reciprocal exchange: opposite-person replies, full back-and-forth cycles,
          and the longest alternating run.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.sessions,
            version: "intimacy-session-v1",
            caveats: [
              "A session allows up to six hours between sexual-scored messages.",
              "A full back-and-forth means two opposite-person switches inside one session.",
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
        <Stat label="Sessions" value={fmtInt(data.overview.sessions)} note={`${fmtInt(data.overview.reciprocal_sessions)} include both people`} />
        <Stat label="Max full cycles" value={fmtInt(data.overview.max_back_and_forths)} note="two sender switches per cycle" />
        <Stat label="Max replies" value={fmtInt(data.overview.max_opposite_replies)} note="opposite-person sexual replies" />
        <Stat label="Longest run" value={fmtInt(data.overview.longest_alternating_run)} note="alternating sexual turns" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Back-and-forth distribution</h2>
        <div className="desire-distribution">
          {data.distribution.map((item) => (
            <div key={item.label} className="desire-distribution-row">
              <span>{item.label}</span>
              <div className="desire-meter">
                <span style={{ width: `${Math.max(2, (item.sessions / maxDistribution) * 100)}%` }} />
              </div>
              <strong>{fmtInt(item.sessions)}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Longest reciprocal sessions</h2>
        <div className="desire-session-grid">
          {data.sessions.map((session) => (
            <SessionCard key={session.key} session={session} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {data.overview.generated_at.slice(0, 19).replace("T", " ")} UTC from{" "}
        <code>seg_message_intimacy_scores</code> and six-hour session grouping.
      </p>
    </div>
  );
}

function SessionCard({ session }: { session: DesireBackAndForthSession }) {
  const totalScore = session.me_score + session.them_score;
  const meShare = totalScore ? session.me_score / totalScore : 0;
  return (
    <article className="panel desire-session-card">
      <div className="desire-episode-head">
        <div>
          <div className="capsule-kicker">{session.ym} / {session.mode}</div>
          <h3>{fmtDate(session.start_ts, { withTime: true })}</h3>
          <div className="hint">
            {fmtDuration(session.duration_minutes * 60)} / {fmtInt(session.sexual_messages)} horny turns / starts {session.initiator}
          </div>
        </div>
        <div className="capsule-score">
          {fmtInt(session.back_and_forths)}
          <span>full cycles</span>
        </div>
      </div>

      <div className="sender-split">
        <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
      </div>
      <div className="desire-session-metrics">
        <span>{fmtInt(session.opposite_replies)} opposite replies</span>
        <span>{fmtInt(session.longest_alternating_run)} turn alternating run</span>
        <span>{fmtDuration(session.average_gap_minutes * 60)} avg gap</span>
        <span>{session.intensity.toFixed(1)} intensity</span>
      </div>

      <div className="capsule-why">
        {[...session.signals, ...session.motifs].slice(0, 8).map((signal) => (
          <span key={signal}>{signal}</span>
        ))}
      </div>

      <div className="capsule-excerpts">
        {session.snippets.map((snippet) => (
          <SnippetLine key={snippet.msg_id} snippet={snippet} />
        ))}
      </div>
    </article>
  );
}

function SnippetLine({ snippet }: { snippet: DesireSnippet }) {
  return (
    <div className={snippet.sender === "Me" ? "capsule-excerpt me" : "capsule-excerpt them"}>
      <div>
        <strong>{snippet.sender}</strong>
        <span>{fmtDate(snippet.ts, { withTime: true })}</span>
      </div>
      <p>{snippet.text}</p>
      <EvidenceLink
        evidence={{
          label: "Open day in Browse",
          date: bucket(snippet.ts, "ymd"),
          note: `score ${snippet.sexual_score.toFixed(1)}`,
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
