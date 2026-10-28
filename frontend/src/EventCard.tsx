import { PointerEvent, useRef, useState } from "react";
import { DigestEvent, ResultsCard } from "./api";
import { ago, Ext, pct, Sheet, Spark, tone } from "./ui";

const CAT_CLASS: Record<string, string> = {
  results: "c-results", management_change: "c-mgmt", "M&A": "c-deal", fund_raise: "c-deal", litigation: "c-risk",
  pledging: "c-risk", credit_rating: "c-rating", insider_trading: "c-risk",
};

/** Horizontal swipe to clear, like a mail inbox. Falls back to the ✓ button. */
function useSwipe(onDismiss: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);
  const handlers = {
    onPointerDown: (e: PointerEvent) => { if (e.pointerType !== "mouse") start.current = { x: e.clientX, y: e.clientY }; },
    onPointerMove: (e: PointerEvent) => {
      if (!start.current) return;
      const x = e.clientX - start.current.x, y = e.clientY - start.current.y;
      if (Math.abs(y) > Math.abs(x) && Math.abs(dx) < 8) { start.current = null; return; }
      setDx(Math.min(0, x));
    },
    onPointerUp: () => { if (dx < -110) onDismiss(); start.current = null; setDx(0); },
    onPointerCancel: () => { start.current = null; setDx(0); },
  };
  return { dx, handlers };
}

export function EventCard({ ev, onDismiss, go }: { ev: DigestEvent; onDismiss: () => void; go: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const { dx, handlers } = useSwipe(onDismiss);
  const llm = ev.lead.llm;
  const people = llm?.people?.filter((p) => p.name) || [];
  return (
    <>
      <article className={`card event ${CAT_CLASS[ev.category] || ""}`} style={{ transform: dx ? `translateX(${dx}px)` : undefined, opacity: dx ? 1 + dx / 300 : 1 }}
               {...handlers}>
        <header className="event-head">
          <button className="co" onClick={() => go(`/c/${ev.symbol}`)}>
            <span className="sym">{ev.symbol}</span>
            <span className="co-name">{ev.name}</span>
          </button>
          <span className="tag">{ev.label}</span>
          <span className="when">{ago(ev.ts)}</span>
        </header>

        <div className="event-body" onClick={() => setOpen(true)} role="button" tabIndex={0}
             onKeyDown={(e) => e.key === "Enter" && setOpen(true)}>
          {ev.card ? <ResultsBlock card={ev.card} /> : (
            <p className="event-title">{ev.lead.summary || ev.lead.headline}</p>
          )}
          {people.length > 0 && (
            <ul className="people">
              {people.map((p, i) => (
                <li key={i}>
                  <div><strong>{p.name}</strong> <span className={`chg chg-${p.change}`}>{p.change}</span> {p.role}
                    {p.previous_role && <span className="muted"> · previously {p.previous_role}</span>}</div>
                  {p.background && (
                    <div className="bio" onClick={(e) => e.stopPropagation()}>
                      <p className="bio-line">{p.background}</p>
                      {p.background_source
                        ? <><Ext href={p.background_source}>From the appointment filing</Ext><span className="muted"> · </span></>
                        : <span className="muted">From the company's filing · </span>}
                      <Ext href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(p.name)}`}>LinkedIn</Ext>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="event-foot">
          <div className="why">{ev.lead.reasons.slice(1).map((r, i) => <span key={i} className="why-chip">{r}</span>)}</div>
          {ev.spark && <Spark data={ev.spark} />}
          <button className="done" onClick={onDismiss} aria-label="Clear from brief">✓</button>
        </footer>
        {ev.related.length > 0 && (
          <button className="related" onClick={() => setOpen(true)}>+{ev.related.length} related filing{ev.related.length > 1 ? "s" : ""}</button>
        )}
      </article>
      <FilingSheet ev={ev} open={open} onClose={() => setOpen(false)} go={go} />
    </>
  );
}

export function ResultsBlock({ card, compact = false }: { card: ResultsCard; compact?: boolean }) {
  if (card.status === "pending" || !card.metrics) return <p className="event-title">{card.quarter} results filed. {card.note}</p>;
  return (
    <div className="results">
      <div className="results-title">
        <span>{card.quarter} results</span>
        {card.status === "previous" && <span className="badge">{card.pending_quarter} just filed · showing last quarter</span>}
        {card.status === "filing" && <span className="badge in">Read from the filing</span>}
      </div>
      {!compact && card.headline && card.status !== "previous" && <p className="results-headline">{card.headline}</p>}
      <table className="rtable">
        <thead><tr><th /><th>₹ Cr</th><th>QoQ</th><th>YoY</th></tr></thead>
        <tbody>
          {card.metrics.map((m) => (
            <tr key={m.name}>
              <th scope="row">{m.name}</th>
              <td className="num">{m.value == null ? "—" : m.value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
              <td className={`num ${tone(m.qoq)}`}>{pct(m.qoq, 0)}</td>
              <td className={`num ${tone(m.yoy)}`}>{pct(m.yoy, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {card.margins && Object.keys(card.margins).length > 0 && (
        <div className="margins">
          {Object.entries(card.margins).map(([k, v]) => (
            <span key={k} className="margin-chip">{k} <strong>{v.value}%</strong>
              <span className={tone(k === "Gross NPA" ? -v.yoy_bps : v.yoy_bps)}> {v.yoy_bps > 0 ? "+" : ""}{v.yoy_bps}bps</span></span>
          ))}
        </div>
      )}
      {card.lender && <p className="footnote">Lender: Net Interest Income shown in place of EBITDA.</p>}
      {card.status === "filing" && (
        <p className="footnote">{card.note} {card.source && <Ext href={`${card.source}#page=${card.page}`}>Filing p.{card.page}</Ext>}</p>
      )}
    </div>
  );
}

export function EventRow({ ev, onDismiss, go }: { ev: DigestEvent; onDismiss: () => void; go: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const { dx, handlers } = useSwipe(onDismiss);
  return (
    <>
      <div className="row" style={{ transform: dx ? `translateX(${dx}px)` : undefined }} {...handlers}>
        <button className="row-main" onClick={() => setOpen(true)}>
          <span className="sym">{ev.symbol}</span>
          <span className="row-text">{ev.lead.summary || ev.lead.headline}</span>
        </button>
        <span className="tag small">{ev.label}</span>
        <button className="done small" onClick={onDismiss} aria-label="Clear">✓</button>
      </div>
      <FilingSheet ev={ev} open={open} onClose={() => setOpen(false)} go={go} />
    </>
  );
}

function FilingSheet({ ev, open, onClose, go }: { ev: DigestEvent; open: boolean; onClose: () => void; go: (p: string) => void }) {
  const all = [ev.lead, ...ev.related];
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="sheet-head">
        <div className="kicker">{ev.label} · {ev.symbol}</div>
        <h3>{ev.name}</h3>
      </div>
      {ev.card && <ResultsBlock card={ev.card} />}
      {ev.lead.llm && (
        <div className="evidence">
          <p>{ev.lead.llm.summary}</p>
          {ev.lead.llm.evidence && (
            <blockquote>
              “{ev.lead.llm.evidence}”
              <cite>{ev.lead.llm.evidence_verified ? "Verified in filing" : "Not found verbatim in filing — treat with care"}</cite>
            </blockquote>
          )}
        </div>
      )}
      <div className="why-block">
        <div className="kicker">Why it's ranked here · score {Math.round(ev.score)}</div>
        <ul>{ev.lead.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      </div>
      <div className="kicker">Filings</div>
      <ul className="filings">
        {all.map((f) => (
          <li key={f.id}>
            <a href={f.url} target="_blank" rel="noopener noreferrer">
              <span className="filing-text">{f.headline}</span>
              <span className="muted">{f.subject} · {new Date(f.ts).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · PDF ↗</span>
            </a>
          </li>
        ))}
      </ul>
      <button className="btn wide" onClick={() => { onClose(); go(`/c/${ev.symbol}`); }}>Research {ev.symbol} →</button>
      {ev.card?.metrics && <p className="footnote">Figures from reported statements as standardised by screener.in; consolidated where available.</p>}
    </Sheet>
  );
}
