import { Link, createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { z } from "zod";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtInt } from "~/lib/format";
import { askArchive, type AskMessageHit, type AskSegmentHit, type AskSynthesis } from "~/server/ask-queries";

const askSearchSchema = z.object({
  q: z.string().catch(""),
  sensitive: z.preprocess(searchBoolean, z.boolean()).catch(false),
  synthesize: z.preprocess(searchBoolean, z.boolean()).catch(false),
});

export const Route = createFileRoute("/ask")({
  validateSearch: (search) => askSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const q = deps.q.trim();
    const result = q.length >= 2 ? await askArchive({ data: { q, sensitive: deps.sensitive, synthesize: deps.synthesize } }) : null;
    return { result };
  },
  component: AskPage,
});

function searchBoolean(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === true || raw === 1 || raw === "1" || raw === "true" || raw === "on";
}

function AskPage() {
  const { result } = Route.useLoaderData();
  const search = Route.useSearch();

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Retrieval</div>
        <PageTitleRow activePath="/ask" />
        <p className="page-lede">
          Search the archive in natural language and get cited message/segment matches. Retrieval-only mode keeps message text on this server; synthesis requires an explicit external-LLM toggle.
        </p>
        <MethodBadge
          meta={{
            kind: search.synthesize ? "speculative" : "descriptive",
            sample: result?.total_messages,
            version: "ask-retrieval-v1",
            caveats: [
              "Retrieval is lexical and segment-based, not semantic proof.",
              "External synthesis is opt-in and receives redacted snippets.",
            ],
          }}
          showConfidence={Boolean(result)}
        />
      </div>

      <form className="ask-search-panel" action="/ask" method="get">
        <input name="q" defaultValue={search.q} placeholder="what helps us reconnect after silence" />
        <label>
          <input name="sensitive" type="checkbox" value="1" defaultChecked={search.sensitive} />
          <span>Include sensitive</span>
        </label>
        <label>
          <input name="synthesize" type="checkbox" value="1" defaultChecked={search.synthesize} />
          <span>Use Anthropic</span>
        </label>
        <button type="submit">Search</button>
      </form>

      {search.synthesize ? (
        <div className="ask-llm-banner">
          This sends retrieved, redacted snippets to Anthropic for synthesis. Retrieval remains local when this is off.
        </div>
      ) : null}

      {result ? (
        <>
          {result.synthesis ? <SynthesisPanel synthesis={result.synthesis} /> : null}

          <section className="section">
            <h2><span className="num">01</span> Segment matches</h2>
            <div className="ask-result-grid">
              {result.segments.map((segment) => (
                <SegmentCard key={segment.segment_id} segment={segment} />
              ))}
            </div>
          </section>

          {result.loose_messages.length > 0 && (
            <section className="section">
              <h2><span className="num">02</span> Message matches</h2>
              <div className="ask-loose-list">
                {result.loose_messages.map((message) => (
                  <MessageHit key={message.id} message={message} />
                ))}
              </div>
            </section>
          )}

          <p className="hint turn-generated">
            Retrieval returned {fmtInt(result.total_messages)} message hits for "{result.q}".
            {result.synthesis ? ` Synthesis audit: ${result.synthesis.audit_path}.` : " No external LLM request was made."}
          </p>
        </>
      ) : (
        <section className="section">
          <div className="panel ask-empty">
            <p>Enter a query to retrieve matching messages and segments.</p>
          </div>
        </section>
      )}
    </div>
  );
}

function SynthesisPanel({ synthesis }: { synthesis: AskSynthesis }) {
  const redactionCount = synthesis.redactions.phone + synthesis.redactions.email + synthesis.redactions.address + synthesis.redactions.name;
  return (
    <section className="section">
      <h2><span className="num">00</span> Synthesis</h2>
      <article className={`panel ask-synthesis ${synthesis.status}`}>
        <div className="ask-synthesis-head">
          <strong>{synthesis.status === "ready" ? synthesis.model : synthesis.status}</strong>
          <span>{fmtInt(synthesis.outbound_chars)} outbound chars · {fmtInt(redactionCount)} redactions</span>
        </div>
        {synthesis.answer ? <p>{synthesis.answer}</p> : <p>{synthesis.message}</p>}
        {synthesis.citations.length ? (
          <div className="ask-citations">
            {synthesis.citations.map((id) => <span key={id}>#{id}</span>)}
          </div>
        ) : null}
      </article>
    </section>
  );
}

function SegmentCard({ segment }: { segment: AskSegmentHit }) {
  return (
    <article className="panel ask-segment-card">
      <div className="ask-card-head">
        <div>
          <span>{segment.category.replace(/_/g, " ")}</span>
          <div className="turn-block-title">{segment.topic_label}</div>
        </div>
        <strong>#{segment.segment_id}</strong>
      </div>
      <div className="ask-meta">
        <span>{fmtInt(segment.messages.length)} hits</span>
        <span>{fmtDate(segment.first_ts)} - {fmtDate(segment.last_ts)}</span>
      </div>
      <div className="ask-message-list">
        {segment.messages.slice(0, 4).map((message) => (
          <MessageHit key={message.id} message={message} />
        ))}
      </div>
      <Link className="ask-browse-link" to="/browse" search={{ date: bucket(segment.first_ts, "ymd"), q: "", filter: "all", sender: "both" }}>
        Open nearby messages
      </Link>
    </article>
  );
}

function MessageHit({ message }: { message: AskMessageHit }) {
  return (
    <div className="ask-message-hit">
      <span>{message.sender} · {fmtDate(message.ts, { withTime: true })}</span>
      <p><Snippet text={message.snippet || message.text} /></p>
    </div>
  );
}

function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<mark>|<\/mark>)/);
  let marked = false;
  let cursor = 0;
  return (
    <>
      {parts.map((part) => {
        const key = `${cursor}:${part}`;
        cursor += part.length;
        if (part === "<mark>") {
          marked = true;
          return null;
        }
        if (part === "</mark>") {
          marked = false;
          return null;
        }
        return marked ? <mark key={key}>{part}</mark> : <span key={key}>{part}</span>;
      })}
    </>
  );
}
