import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getGestures,
  type GestureDrawFeature,
  type GestureExample,
  type GestureMonth,
  type ObjectChannel,
  type ReactionTypeCard,
  type ThreadPattern,
} from "~/server/gesture-queries";

export const Route = createFileRoute("/gestures")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getGestures({ data: deps }),
  component: GesturesPage,
});

function GesturesPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxMonth = Math.max(
    ...data.months.map((month) => month.tapbacks + month.threaded_replies + month.objects),
    1,
  );

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Paralinguistic layer</div>
        <PageTitleRow activePath="/gestures" />
        <p className="page-lede">
          A backchannel view of the things around the words: tapbacks, threaded replies,
          games, maps, links, photos, app payloads, and expressive sends.
        </p>
        <MethodBadge
          meta={{
            kind: "descriptive",
            sample: data.overview.real_messages,
            version: "gestures-v1",
            caveats: [
              "Tapbacks are joined to normalized target GUIDs.",
              "Sender filters apply to source gesture rows while preserving target and reply context.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} gestures only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Tapbacks" value={fmtInt(data.overview.tapbacks)} note={data.overview.top_reaction} />
        <Stat label="Threaded replies" value={fmtInt(data.overview.threaded_replies)} note="direct reply anchors" />
        <Stat label="Sent objects" value={fmtInt(data.overview.sent_objects)} note={data.overview.busiest_object_channel} />
        <Stat label="Strongest draw" value={data.overview.strongest_draw} note="enriched among reacted messages" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Backchannel calendar</h2>
        <div className="panel gesture-month-panel">
          <div className="hint">
            Each month stacks tapbacks, threaded replies, and sent objects. Inner ticks split hearts,
            laughs, links, games, and media.
          </div>
          <div className="gesture-month-scroll">
            <div className="gesture-month-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(10px, 1fr))` }}>
              {data.months.map((month) => (
                <MonthColumn key={month.ym} month={month} maxMonth={maxMonth} />
              ))}
            </div>
            <div className="restart-axis">
              <span>{data.months[0]?.ym}</span>
              <span>{data.months[data.months.length - 1]?.ym}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Reaction ecology</h2>
        <div className="gesture-reaction-grid">
          {data.reactions.map((reaction) => (
            <ReactionCard key={reaction.key} reaction={reaction} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> What draws a gesture</h2>
        <div className="gesture-draw-grid">
          {data.draw_features.map((feature) => (
            <DrawFeatureCard key={feature.key} feature={feature} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Threads and objects</h2>
        <div className="gesture-split-grid">
          <div>
            <div className="turn-block-title gesture-subhead">Thread anchors</div>
            <div className="gesture-thread-list">
              {data.thread_patterns.map((pattern) => (
                <ThreadPatternCard key={pattern.key} pattern={pattern} />
              ))}
            </div>
          </div>
          <div>
            <div className="turn-block-title gesture-subhead">Object channels</div>
            <div className="gesture-thread-list">
              {data.object_channels.map((channel) => (
                <ObjectChannelCard key={channel.key} channel={channel} />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">05</span> Gesture evidence</h2>
        <div className="gesture-example-grid">
          {data.examples.map((example) => (
            <ExampleCard key={`${example.kind}-${example.ts}-${example.label}`} example={example} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from{" "}
        {fmtInt(data.overview.real_messages)} real messages. Method: normalized tapback target
        joins, reply-to anchor joins, six-hour object response windows, and smoothed log-odds
        enrichment for reacted-message features.
      </p>
    </div>
  );
}

function MonthColumn({ month, maxMonth }: { month: GestureMonth; maxMonth: number }) {
  const total = month.tapbacks + month.threaded_replies + month.objects;
  const height = Math.max(3, (total / maxMonth) * 100);
  return (
    <div
      className="gesture-month-column"
      title={`${month.ym}: ${fmtInt(month.tapbacks)} tapbacks, ${fmtInt(month.threaded_replies)} threaded replies, ${fmtInt(month.objects)} objects`}
      style={{ height: `${height}%` }}
    >
      <span className="gesture-month-slice tapbacks" style={{ flexGrow: Math.max(1, month.tapbacks) }} />
      <span className="gesture-month-slice threads" style={{ flexGrow: Math.max(1, month.threaded_replies) }} />
      <span className="gesture-month-slice objects" style={{ flexGrow: Math.max(1, month.objects) }} />
      <i className="gesture-heart-mark" style={{ height: `${formatMarker(month.hearts, total)}%` }} />
      <i className="gesture-laugh-mark" style={{ height: `${formatMarker(month.laughs, total)}%` }} />
    </div>
  );
}

function ReactionCard({ reaction }: { reaction: ReactionTypeCard }) {
  const fromTotal = Math.max(reaction.from_me + reaction.from_them, 1);
  const targetTotal = Math.max(reaction.target_me + reaction.target_them, 1);
  return (
    <article className="panel gesture-reaction-card">
      <div className="gesture-card-head">
        <div>
          <div className="turn-block-title">{reaction.label}</div>
          <p>{reaction.top_target_feature} on {formatPct(reaction.target_feature_rate)} of targets</p>
        </div>
        <strong>{fmtInt(reaction.count)}</strong>
      </div>
      <GestureBar
        label="sender"
        leftLabel="Me"
        rightLabel="Them"
        left={reaction.from_me / fromTotal}
        right={reaction.from_them / fromTotal}
      />
      <GestureBar
        label="target"
        leftLabel="Me"
        rightLabel="Them"
        left={reaction.target_me / targetTotal}
        right={reaction.target_them / targetTotal}
      />
      <div className="gesture-mini-meta">
        <span>{reaction.median_delay_seconds == null ? "no delay" : `${fmtDuration(reaction.median_delay_seconds)} median`}</span>
        <span>{fmtInt(reaction.target_me)} Me targets</span>
        <span>{fmtInt(reaction.target_them)} Them targets</span>
      </div>
      <MiniExamples examples={reaction.examples} />
    </article>
  );
}

function DrawFeatureCard({ feature }: { feature: GestureDrawFeature }) {
  const liftWidth = Math.min(100, Math.max(4, feature.lift * 38));
  return (
    <article className="panel gesture-draw-card">
      <div className="gesture-card-head">
        <div>
          <div className="turn-block-title">{feature.label}</div>
          <p>{feature.description}</p>
        </div>
        <strong>{feature.lift.toFixed(2)}x</strong>
      </div>
      <div className="gesture-draw-meter">
        <span>baseline</span>
        <div><i className="baseline" style={{ width: `${Math.max(3, feature.baseline_rate * 100)}%` }} /></div>
        <b>{formatPct(feature.baseline_rate)}</b>
        <span>reacted</span>
        <div><i style={{ width: `${Math.max(3, feature.reacted_rate * 100)}%` }} /></div>
        <b>{formatPct(feature.reacted_rate)}</b>
      </div>
      <div className="gesture-lift-ruler">
        <i style={{ width: `${liftWidth}%` }} />
      </div>
      <div className="gesture-mini-meta">
        <span>{fmtInt(feature.reacted_count)} reacted targets</span>
        <span>{formatSigned(feature.log_odds_z)} z</span>
      </div>
    </article>
  );
}

function ThreadPatternCard({ pattern }: { pattern: ThreadPattern }) {
  const total = Math.max(pattern.me_replies + pattern.them_replies, 1);
  return (
    <article className="panel gesture-thread-card">
      <div className="gesture-card-head compact">
        <div>
          <div className="turn-block-title">{pattern.label}</div>
          <p>{pattern.description}</p>
        </div>
        <strong>{fmtInt(pattern.count)}</strong>
      </div>
      <GestureBar
        label="reply"
        leftLabel="Me"
        rightLabel="Them"
        left={pattern.me_replies / total}
        right={pattern.them_replies / total}
      />
      <div className="gesture-mini-meta">
        <span>{pattern.median_gap_seconds == null ? "no gap" : `${fmtDuration(pattern.median_gap_seconds)} median gap`}</span>
      </div>
      <MiniExamples examples={pattern.examples} />
    </article>
  );
}

function ObjectChannelCard({ channel }: { channel: ObjectChannel }) {
  const total = Math.max(channel.from_me + channel.from_them, 1);
  return (
    <article className="panel gesture-thread-card">
      <div className="gesture-card-head compact">
        <div>
          <div className="turn-block-title">{channel.label}</div>
          <p>{channel.description}</p>
        </div>
        <strong>{fmtInt(channel.count)}</strong>
      </div>
      <GestureBar
        label="sender"
        leftLabel="Me"
        rightLabel="Them"
        left={channel.from_me / total}
        right={channel.from_them / total}
      />
      <div className="gesture-mini-meta">
        <span>{formatPct(channel.reply_rate)} six-hour reply rate</span>
        <span>{channel.median_reply_seconds == null ? "no median" : fmtDuration(channel.median_reply_seconds)}</span>
        <span>peak {channel.peak_ym}</span>
      </div>
      <MiniExamples examples={channel.examples} />
    </article>
  );
}

function GestureBar({
  label,
  leftLabel,
  rightLabel,
  left,
  right,
}: {
  label: string;
  leftLabel: string;
  rightLabel: string;
  left: number;
  right: number;
}) {
  return (
    <div className="gesture-bar-row">
      <span>{label}</span>
      <div className="gesture-two-bar">
        <i className="left" style={{ width: `${Math.max(2, left * 100)}%` }} />
        <i className="right" style={{ width: `${Math.max(2, right * 100)}%` }} />
      </div>
      <b>{leftLabel} {formatPct(left)} / {rightLabel} {formatPct(right)}</b>
    </div>
  );
}

function MiniExamples({ examples }: { examples: GestureExample[] }) {
  return (
    <div className="gesture-mini-examples">
      {examples.map((example) => (
        <div key={`${example.kind}-${example.ts}-${example.primary_text}`}>
          <span>{example.context}</span>
          <p>{example.primary_text}</p>
          <EvidenceLink evidence={exampleEvidence(example, "Open in browse")} />
        </div>
      ))}
    </div>
  );
}

function ExampleCard({ example }: { example: GestureExample }) {
  return (
    <article className={`panel gesture-example-card ${example.kind}`}>
      <div className="gesture-example-head">
        <div>
          <span>{example.kind}</span>
          <strong>{example.label}</strong>
        </div>
        <b>{fmtDate(example.ts, { withTime: true })}</b>
      </div>
      <div className="gesture-mini-meta">
        <span>{example.context}</span>
        {example.delay_seconds != null && <span>{fmtDuration(example.delay_seconds)}</span>}
      </div>
      <EvidenceLink evidence={exampleEvidence(example, "Browse evidence")} />
      <div className="gesture-example-pair">
        <div>
          <strong>{example.target_sender ?? example.sender}</strong>
          <p>{example.primary_text}</p>
        </div>
        {example.response_text && (
          <div>
            <strong>{example.sender}</strong>
            <p>{example.response_text}</p>
          </div>
        )}
      </div>
    </article>
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

function formatMarker(part: number, total: number) {
  return Math.max(0, Math.min(100, total === 0 ? 0 : (part / total) * 100));
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function formatSigned(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function exampleEvidence(example: GestureExample, label: string) {
  return {
    label,
    date: example.ymd,
    sender: senderParam(example.target_sender ?? example.sender),
    note: example.context,
  };
}

function senderParam(sender: GestureExample["sender"]) {
  return sender === "Me" ? "me" as const : "them" as const;
}

function formatGeneratedAt(value: string) {
  return value.slice(0, 19).replace("T", " ");
}
