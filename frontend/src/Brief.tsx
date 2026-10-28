import { useEffect, useMemo, useRef, useState } from "react";
import { api, Digest, DigestEvent, Mover } from "./api";
import { EventCard, EventRow } from "./EventCard";
import { ago, ErrorNote, Loading, pct, tone, useAsync } from "./ui";

const WINDOWS = [
  { h: 24, label: "24h" },
  { h: 72, label: "3 days" },
  { h: 168, label: "Week" },
  { h: 720, label: "Month" },
];
const DISMISSED = "finn.dismissed";

function loadDismissed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED) || "[]")); } catch { return new Set(); }
}
function saveDismissed(s: Set<string>) {
  try { localStorage.setItem(DISMISSED, JSON.stringify([...s].slice(-500))); } catch { /* private mode */ }
}

function greeting(now: Date) {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** A spoken version of the brief: the top items in plain sentences. */
function script(d: Digest, events: DigestEvent[]): string {
  const parts = [`${greeting(new Date())}. ${d.filings_total} filings across your portfolio; ${events.length} worth your attention.`];
  for (const e of events.slice(0, 5)) {
    const c = e.card;
    if (c?.status === "ready" && c.headline) parts.push(`${e.name}, ${c.quarter} results. ${c.headline}`);
    else parts.push(`${e.name}. ${e.lead.summary || e.lead.headline}.`);
  }
  for (const m of d.movers.slice(0, 2)) parts.push(`${m.symbol} moved ${m.move_pct.toFixed(1)} percent${m.vol_x && m.vol_x >= 2 ? ` on ${m.vol_x.toFixed(1)} times normal volume` : ""}.`);
  return parts.join(" ").replace(/₹/g, "rupees ").replace(/\bCr\b/g, "crore").replace(/YoY/g, "year on year").replace(/QoQ/g, "quarter on quarter");
}

export function Brief({ go }: { go: (path: string) => void }) {
  const [hours, setHours] = useState<number>(() => Number(sessionStorage.getItem("finn.hours")) || 24);
  const { data, error, loading, reload } = useAsync(() => api.digest(hours), [hours]);
  const [dismissed, setDismissed] = useState(loadDismissed);
  const [lastCleared, setLastCleared] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [showRoutine, setShowRoutine] = useState(false);

  useEffect(() => { try { sessionStorage.setItem("finn.hours", String(hours)); } catch { /* ignore */ } }, [hours]);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const top = useMemo(() => (data?.top || []).filter((e) => !dismissed.has(e.key)), [data, dismissed]);
  const glance = useMemo(() => (data?.glance || []).filter((e) => !dismissed.has(e.key)), [data, dismissed]);
  const clearedHere = data ? data.top.length + data.glance.length - top.length - glance.length : 0;

  const dismiss = (key: string) => {
    const next = new Set(dismissed); next.add(key);
    setDismissed(next); saveDismissed(next); setLastCleared(key);
  };
  const undo = () => {
    if (!lastCleared) return;
    const next = new Set(dismissed); next.delete(lastCleared);
    setDismissed(next); saveDismissed(next); setLastCleared(null);
  };

  const listen = () => {
    if (!data || !window.speechSynthesis) return;
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    const u = new SpeechSynthesisUtterance(script(data, [...top, ...glance]));
    u.lang = "en-IN"; u.rate = 1.05;
    u.onend = u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
    setSpeaking(true);
  };

  const now = new Date();
  return (
    <div className="page">
      <header className="brief-head">
        <div className="eyebrow">{now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</div>
        <h1 className="display">{greeting(now)}</h1>
        {data && (
          <p className="funnel">
            <strong>{data.filings_total}</strong> filings across your portfolio
            <span className="arrow">→</span>
            <strong className="accent">{top.length + glance.length}</strong> worth your time
          </p>
        )}
        <div className="brief-tools">
          <div className="chips" role="tablist" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button key={w.h} role="tab" aria-selected={hours === w.h} className={`chip ${hours === w.h ? "on" : ""}`}
                      onClick={() => setHours(w.h)}>{w.label}</button>
            ))}
          </div>
          {"speechSynthesis" in window && data && (
            <button className={`listen ${speaking ? "on" : ""}`} onClick={listen} aria-label={speaking ? "Stop" : "Listen to the brief"}>
              {speaking ? <StopIcon /> : <PlayIcon />} {speaking ? "Stop" : "Listen"}
            </button>
          )}
        </div>
      </header>

      {loading && !data && <Loading label="Reading the exchanges" />}
      {error && <ErrorNote error={error} onRetry={reload} />}

      {data && (
        <>
          {data.alerts_unseen > 0 && (
            <button className="alert-banner" onClick={() => go("/alerts")}>
              <span className="pulse" /> {data.alerts_unseen} alert{data.alerts_unseen > 1 ? "s" : ""} crossed your thresholds
              <span className="chev">›</span>
            </button>
          )}

          {data.movers.length > 0 && <Movers movers={data.movers} go={go} />}

          {top.length > 0 && <div className="group-label">Needs your attention</div>}
          {top.map((e) => <EventCard key={e.key} ev={e} onDismiss={() => dismiss(e.key)} go={go} />)}

          {glance.length > 0 && <div className="group-label">Worth a glance</div>}
          {glance.length > 0 && (
            <div className="list-card">
              {glance.map((e) => <EventRow key={e.key} ev={e} onDismiss={() => dismiss(e.key)} go={go} />)}
            </div>
          )}

          {top.length + glance.length === 0 && (
            <div className="empty">
              <div className="empty-mark">✓</div>
              <h3>{clearedHere ? "Inbox clear" : "Nothing material"}</h3>
              <p>
                {clearedHere ? `You've cleared ${clearedHere} item${clearedHere > 1 ? "s" : ""} in this window.`
                  : `No filing in the last ${WINDOWS.find((w) => w.h === hours)?.label ?? hours + "h"} needed you.`}
                {hours < 168 && <> <button className="link" onClick={() => setHours(hours < 72 ? 72 : 168)}>Look further back</button></>}
              </p>
            </div>
          )}

          {data.routine.count > 0 && (
            <div className="routine">
              <button className="routine-toggle" onClick={() => setShowRoutine(!showRoutine)} aria-expanded={showRoutine}>
                <span>{data.routine.count} routine filings hidden</span>
                <span className="routine-cats">{data.routine.groups.map((g) => g.label).slice(0, 4).join(" · ")}</span>
                <span className={`chev ${showRoutine ? "open" : ""}`}>›</span>
              </button>
              {showRoutine && data.routine.groups.map((g) => (
                <div key={g.category} className="routine-group">
                  <div className="routine-label">{g.label}</div>
                  {g.items.map((it, i) => (
                    <a key={i} href={it.url} target="_blank" rel="noopener noreferrer" className="routine-item">
                      <span className="sym">{it.symbol}</span>
                      <span className="routine-text">{it.text}</span>
                      {it.n > 1 && <span className="count">×{it.n}</span>}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          )}

          <footer className="freshness">
            Filings to {ago(data.freshness.filings_until)} ago · prices to close of {new Date(data.freshness.prices_until).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
          </footer>
        </>
      )}

      {lastCleared && <Toast onUndo={undo} onDone={() => setLastCleared(null)} />}
    </div>
  );
}

function Movers({ movers, go }: { movers: Mover[]; go: (p: string) => void }) {
  return (
    <div className="movers" aria-label="Unusual moves at last close">
      {movers.map((m) => (
        <button key={m.symbol} className="mover" onClick={() => go(`/c/${m.symbol}`)}>
          <span className="sym">{m.symbol}</span>
          <span className={`move ${tone(m.move_pct)}`}>{pct(m.move_pct)}</span>
          {m.vol_x != null && m.vol_x >= 1.5 && <span className="volx">{m.vol_x.toFixed(1)}× vol</span>}
        </button>
      ))}
    </div>
  );
}

function Toast({ onUndo, onDone }: { onUndo: () => void; onDone: () => void }) {
  const t = useRef<number>();
  useEffect(() => { t.current = window.setTimeout(onDone, 4000); return () => clearTimeout(t.current); }, [onDone]);
  return <div className="toast" role="status">Cleared <button className="link" onClick={onUndo}>Undo</button></div>;
}

const PlayIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /></svg>;
const StopIcon = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" /></svg>;
