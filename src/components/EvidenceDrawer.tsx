import { useEffect, useRef, useState } from "react";
import { evidenceHref, type EvidenceRef } from "~/components/EvidenceLink";
import { fmtDate, fmtTime } from "~/lib/format";
import { getEvidenceMessages, type EvidenceMessage } from "~/server/evidence-queries";

export function EvidenceDrawer({
  evidence,
  onClose,
}: {
  evidence: EvidenceRef | null;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<EvidenceMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!evidence) return;
    let cancelled = false;
    setLoading(true);
    getEvidenceMessages({
      data: {
        ids: evidence.ids,
        date: evidence.date,
        from: evidence.from,
        to: evidence.to,
        sender: evidence.sender,
        limit: 120,
      },
    }).then((rows) => {
      if (cancelled) return;
      setMessages(rows);
      setLoading(false);
      requestAnimationFrame(() => closeRef.current?.focus());
    });
    return () => {
      cancelled = true;
    };
  }, [evidence]);

  useEffect(() => {
    if (!evidence) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [evidence, onClose]);

  if (!evidence) return null;

  return (
    <div className="evidence-drawer-shell" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-drawer-title">
        <header className="evidence-drawer-head">
          <div>
            <div className="page-eyebrow">Evidence</div>
            <h2 id="evidence-drawer-title">{evidence.label}</h2>
            {evidence.note && <p>{evidence.note}</p>}
          </div>
          <button ref={closeRef} className="evidence-close" type="button" onClick={onClose} aria-label="Close evidence">
            Close
          </button>
        </header>

        <div className="evidence-drawer-body">
          {loading && <div className="hint">Loading evidence...</div>}
          {!loading && messages.length === 0 && <div className="hint">No messages found for this evidence reference.</div>}
          {!loading && <EvidenceMessageStream messages={messages} />}
        </div>

        <footer className="evidence-drawer-foot">
          <a href={evidenceHref(evidence)}>Open in Browse</a>
        </footer>
      </aside>
    </div>
  );
}

function EvidenceMessageStream({ messages }: { messages: EvidenceMessage[] }) {
  let lastDate = "";

  return (
    <>
      {messages.map((message) => {
        const day = fmtDate(message.ts);
        const showDay = day !== lastDate;
        lastDate = day;
        return (
          <div key={message.id}>
            {showDay && <div className="day-divider"><span>{day}</span></div>}
            <div className={`bubble-row ${message.is_from_me ? "me" : "them"}`}>
              <div className={`bubble ${message.is_from_me ? "me" : "them"}`}>
                {message.text || (message.has_attachment ? <em>attachment</em> : <em>no text</em>)}
                {message.rich_link_url && (
                  <div className="hint" style={{ marginTop: 4 }}>{message.rich_link_url.slice(0, 72)}</div>
                )}
              </div>
              <div className="bubble-meta">{fmtTime(message.ts)}</div>
            </div>
          </div>
        );
      })}
    </>
  );
}
