import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getBids,
  type BidExchange,
  type BidTypeStats,
  type QuestionShape,
} from "~/server/bid-queries";

export const Route = createFileRoute("/bids")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getBids({ data: deps }),
  component: BidsPage,
});

function BidsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const fastestType = [...data.types].sort((a, b) => b.response_share_1h - a.response_share_1h)[0];

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Attention ecology</div>
        <PageTitleRow activePath="/bids" />
        <p className="page-lede">
          Messages that ask something of the other person: questions, plans, care checks,
          affection, repairs, and shared objects. This view measures how the thread receives
          different kinds of bids for attention.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.real_messages,
            version: "bid-response-v1",
            caveats: [
              "A message can count in more than one bid class.",
              "Response timing uses the next other-person message, not explicit thread anchors.",
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
        <Stat label="Bid messages" value={fmtInt(data.overview.bid_messages)} note={`${fmtInt(data.overview.bid_instances)} classified bids`} />
        <Stat label="6h response" value={formatPct(data.overview.response_share_6h)} note="first reply from the other person" />
        <Stat label="Median response" value={data.overview.median_response_seconds == null ? "n/a" : fmtDuration(data.overview.median_response_seconds)} note="across bid instances" />
        <Stat label="Fastest class" value={fastestType?.label ?? "n/a"} note={fastestType ? `${formatPct(fastestType.response_share_1h)} within 1h` : "no data"} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Response map</h2>
        <div className="bid-type-grid">
          {data.types.map((type) => (
            <BidTypeCard key={type.key} type={type} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Question shapes</h2>
        <div className="panel">
          <div className="hint bid-note">
            Question openings are grouped by the first question word found in the message.
            Response means a first reply from the other person within 6 hours.
          </div>
          <div className="question-shape-list">
            {data.question_shapes.map((shape) => (
              <QuestionShapeRow key={shape.key} shape={shape} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Fast catches</h2>
        <div className="bid-exchange-grid">
          {data.fast_exchanges.map((exchange) => (
            <ExchangeCard key={`${exchange.bid_ts}-${exchange.type}-fast`} exchange={exchange} mode="fast" />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Long-hanging bids</h2>
        <div className="bid-exchange-grid">
          {data.long_hanging.map((exchange) => (
            <ExchangeCard key={`${exchange.bid_ts}-${exchange.type}-long`} exchange={exchange} mode="long" />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real
        messages. Response timing uses the next message from the other person, ignoring tapbacks.
      </p>
    </div>
  );
}

function BidTypeCard({ type }: { type: BidTypeStats }) {
  const meShare = type.total ? type.me / type.total : 0;
  return (
    <article className="panel bid-type-card">
      <div className="bid-card-head">
        <div>
          <div className="turn-block-title">{type.label}</div>
          <div className="bid-count">{fmtInt(type.total)}</div>
        </div>
        <div className="bid-speed">
          {formatPct(type.response_share_6h)}
          <span>in 6h</span>
        </div>
      </div>
      <p>{type.description}</p>
      <div className="bid-response-track">
        <div className="bid-response-fill" style={{ width: `${type.response_share_6h * 100}%` }} />
      </div>
      <div className="sender-split">
        <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
      </div>
      <div className="ritual-card-meta">
        <span>Me {fmtInt(type.me)}</span>
        <span>Them {fmtInt(type.them)}</span>
        <span>1h {formatPct(type.response_share_1h)}</span>
        <span>median {type.median_response_seconds == null ? "n/a" : fmtDuration(type.median_response_seconds)}</span>
      </div>
    </article>
  );
}

function QuestionShapeRow({ shape }: { shape: QuestionShape }) {
  const maxWidth = Math.min(100, Math.max(4, shape.response_share_6h * 100));
  return (
    <div className="question-shape-row">
      <div>
        <strong>{shape.label}</strong>
        <span>{fmtInt(shape.count)} questions · Me {fmtInt(shape.me)} · Them {fmtInt(shape.them)}</span>
      </div>
      <div className="question-shape-meter">
        <div style={{ width: `${maxWidth}%` }} />
      </div>
      <span>{formatPct(shape.response_share_6h)} in 6h</span>
    </div>
  );
}

function ExchangeCard({ exchange, mode }: { exchange: BidExchange; mode: "fast" | "long" }) {
  return (
    <article className="panel bid-exchange-card">
      <div className="exchange-head">
        <div>
          <strong>{exchange.type}</strong>
          <span>{exchange.sender} · {fmtDate(exchange.bid_ts, { withTime: true })}</span>
        </div>
        <div className={mode === "fast" ? "exchange-gap fast" : "exchange-gap long"}>
          {exchange.gap_seconds == null ? "open" : fmtDuration(exchange.gap_seconds)}
        </div>
      </div>
      <div className="exchange-message bid">
        <span>{exchange.sender}</span>
        <p>{exchange.bid_preview}</p>
        <EvidenceLink
          evidence={{
            label: "Open bid",
            date: exchange.bid_ymd,
            sender: exchange.sender === "Me" ? "me" : "them",
            note: exchange.type,
          }}
        />
      </div>
      {exchange.response_preview ? (
        <div className="exchange-message response">
          <span>{exchange.responder}</span>
          <p>{exchange.response_preview}</p>
          <EvidenceLink
            evidence={{
              label: "Open reply",
              date: exchange.response_ymd ?? exchange.bid_ymd,
              sender: exchange.responder === "Me" ? "me" : exchange.responder === "Them" ? "them" : "both",
              note: exchange.gap_seconds == null ? "open" : fmtDuration(exchange.gap_seconds),
            }}
          />
        </div>
      ) : (
        <div className="exchange-message response">
          <span>No reply found</span>
          <p>Nothing from the other person before the archive moves on.</p>
        </div>
      )}
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

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
