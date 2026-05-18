import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getInformation,
  type InformationChannel,
  type InformationCue,
  type InformationExample,
  type InformationMonth,
} from "~/server/information-queries";

export const Route = createFileRoute("/information")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getInformation({ data: deps }),
  component: InformationPage,
});

function InformationPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const sourceFilter = search.sender === "me" || search.sender === "them" ? search.sender : "both";
  const visibleChannels = data.channels.filter((channel) => channelVisible(channel.direction, sourceFilter));
  const meChannel = data.channels.find((channel) => channel.direction === "me_to_them");
  const themChannel = data.channels.find((channel) => channel.direction === "them_to_me");
  const maxPairs = Math.max(...data.months.map((month) => month.pairs), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Information theory</div>
        <PageTitleRow activePath="/information" />
        <p className="page-lede">
          The conversation as a two-person channel: message bursts collapse into turns, each turn
          gets a move label, and the route measures how much one person&apos;s move reduces uncertainty
          about the other person&apos;s next move.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: data.overview.reply_pairs,
            version: "reply-information-v1",
            caveats: [
              "Move labels are regex-derived.",
              "Information is local to the next opposite-person turn within 24 hours.",
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
        <Stat label="Collapsed turns" value={fmtInt(data.overview.turns)} note={`${fmtInt(data.overview.reply_pairs)} reply pairs`} />
        <Stat
          label="Me to Them"
          value={sourceFilter === "them" ? "Filtered" : `${(meChannel?.mutual_information ?? 0).toFixed(2)} bits`}
          note={sourceFilter === "them" ? "source filter inactive" : "reply uncertainty removed"}
        />
        <Stat
          label="Them to Me"
          value={sourceFilter === "me" ? "Filtered" : `${(themChannel?.mutual_information ?? 0).toFixed(2)} bits`}
          note={sourceFilter === "me" ? "source filter inactive" : "reply uncertainty removed"}
        />
        <Stat label="Cue codebook" value={fmtInt(data.overview.shared_cues)} note={data.overview.strongest_cue} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Directional channels</h2>
        <div className="info-channel-grid">
          {visibleChannels.map((channel) => (
            <ChannelCard key={channel.direction} channel={channel} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> High-information cues</h2>
        <div className="info-cue-grid">
          {data.cues.map((cue) => (
            <CueCard key={cue.key} cue={cue} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Predictability timeline</h2>
        <div className="panel info-month-panel">
          <div className="info-month-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(8px, 1fr))` }}>
            {data.months.map((month) => (
              <MonthColumn key={month.ym} month={month} maxPairs={maxPairs} />
            ))}
          </div>
          <p className="hint info-note">
            Taller bars have more reply pairs. The red pin rises when reply-move entropy drops and
            the next move is more predictable from the local codebook.
          </p>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Evidence pairs</h2>
        <div className="info-example-grid">
          {data.examples.map((example) => (
            <ExampleCard key={example.key} example={example} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real
        messages. Method: 20-minute turn collapse, 24-hour reply window, move entropy,
        conditional entropy, mutual information, token-to-reply lift, and example retrieval.
      </p>
    </div>
  );
}

function ChannelCard({ channel }: { channel: InformationChannel }) {
  const maxContribution = Math.max(...channel.cells.map((cell) => Math.max(0, cell.contribution_bits)), 0.01);
  const topRows = channel.rows.slice().sort((a, b) => b.count - a.count).slice(0, 5);
  return (
    <article className="panel info-channel-card">
      <div className="info-card-head">
        <div>
          <span>{fmtInt(channel.pairs)} reply pairs</span>
          <strong>{channel.label}</strong>
        </div>
        <b>{channel.mutual_information.toFixed(2)}b</b>
      </div>
      <div className="info-entropy-row">
        <Metric label="reply entropy" value={`${channel.reply_entropy.toFixed(2)}b`} />
        <Metric label="conditional" value={`${channel.conditional_entropy.toFixed(2)}b`} />
        <Metric label="reduction" value={formatPct(channel.uncertainty_reduction)} />
      </div>
      <div className="info-matrix" aria-label={`${channel.label} move information matrix`}>
        {channel.cells.map((cell) => (
          <i
            key={`${cell.source}-${cell.reply}`}
            title={`${cell.source_label} -> ${cell.reply_label}: ${fmtInt(cell.count)} pairs, ${cell.lift.toFixed(1)}x lift`}
            style={{ opacity: Math.max(0.08, Math.min(0.95, Math.max(0, cell.contribution_bits) / maxContribution)) }}
          />
        ))}
      </div>
      <div className="info-row-list">
        {topRows.map((row) => (
          <div key={row.source}>
            <span>{row.label}</span>
            <strong>{row.top_reply}</strong>
            <b>{row.top_lift.toFixed(1)}x</b>
          </div>
        ))}
      </div>
    </article>
  );
}

function CueCard({ cue }: { cue: InformationCue }) {
  return (
    <article className="panel info-cue-card">
      <div className="info-card-head">
        <div>
          <span>{cue.direction_label}</span>
          <strong>{cue.token}</strong>
        </div>
        <b>{cue.lift.toFixed(1)}x</b>
      </div>
      <div className="info-cue-target">
        predicts <strong>{cue.reply_label}</strong> replies
      </div>
      <div className="info-tags">
        <span>{fmtInt(cue.count)} hits</span>
        <span>{cue.contribution_bits.toFixed(2)} bits</span>
      </div>
    </article>
  );
}

function MonthColumn({ month, maxPairs }: { month: InformationMonth; maxPairs: number }) {
  return (
    <div className="info-month-column" title={`${month.ym}: ${fmtInt(month.pairs)} pairs, ${month.entropy.toFixed(2)}b entropy, ${formatPct(month.predictability)} predictable`}>
      <span style={{ height: `${Math.max(4, (month.pairs / maxPairs) * 100)}%` }} />
      <i style={{ bottom: `${Math.max(4, month.predictability * 92)}%` }} />
    </div>
  );
}

function ExampleCard({ example }: { example: InformationExample }) {
  return (
    <article className="panel info-example-card">
      <div className="info-card-head">
        <div>
          <span>{example.direction_label}</span>
          <strong>{example.cue} to {example.reply_label}</strong>
        </div>
        <b>{example.lift.toFixed(1)}x</b>
      </div>
      <div className="info-example-pair">
        <div>
          <span>{example.source_sender} · {fmtDate(example.source_ts, { withTime: true })}</span>
          <p>{example.source_text}</p>
          <EvidenceLink
            evidence={{
              label: "Browse source",
              date: example.source_ymd,
              sender: senderParam(example.source_sender),
              note: `${example.cue} cue`,
            }}
          />
        </div>
        <div>
          <span>{example.reply_sender} · {fmtDate(example.reply_ts, { withTime: true })}</span>
          <p>{example.reply_text}</p>
          <EvidenceLink
            evidence={{
              label: "Browse reply",
              date: example.reply_ymd,
              sender: senderParam(example.reply_sender),
              note: example.reply_label,
            }}
          />
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
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

function channelVisible(direction: InformationChannel["direction"], sourceFilter: "me" | "them" | "both") {
  if (sourceFilter === "me") return direction === "me_to_them";
  if (sourceFilter === "them") return direction === "them_to_me";
  return true;
}

function senderParam(sender: InformationExample["source_sender"]) {
  return sender === "Me" ? "me" as const : "them" as const;
}

function formatGeneratedAt(value: string) {
  return value.slice(0, 19).replace("T", " ");
}
