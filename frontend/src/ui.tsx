import { ReactNode, useEffect, useState } from "react";

/** Indian convention: ₹ crore, and lakh crore (L Cr) once a figure reaches 1,00,000 Cr. */
export const cr = (v: number | null | undefined) =>
  v == null ? "—" : Math.abs(v) >= 100000 ? `₹${(v / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L Cr` : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
export const num = (v: number | null | undefined, d = 0) => (v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d }));
export const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
export const tone = (v: number | null | undefined) => (v == null || Math.abs(v) < 0.05 ? "" : v > 0 ? "up" : "down");

export function ago(ts: string, now = new Date()): string {
  const t = new Date(ts.length <= 10 ? ts + "T15:30:00" : ts);
  const mins = Math.round((now.getTime() - t.getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  const days = Math.round(mins / 1440);
  return days < 7 ? `${days}d` : t.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function Spark({ data, w = 72, h = 24, strokeWidth = 1.5 }: { data: number[]; w?: number; h?: number; strokeWidth?: number }) {
  if (!data || data.length < 2) return <svg width={w} height={h} />;
  const lo = Math.min(...data), hi = Math.max(...data), span = hi - lo || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - lo) / span) * (h - 4)}`).join(" ");
  const up = data[data.length - 1] >= data[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={`spark ${up ? "up" : "down"}`} aria-hidden>
      <polyline points={pts} fill="none" strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Small bar chart for annual series; negative bars drop below the axis. */
export function Bars({ labels, values, highlightLast = true, fmt = (v: number) => num(v) }: {
  labels: string[]; values: (number | null)[]; highlightLast?: boolean; fmt?: (v: number) => string;
}) {
  const vals = values.map((v) => v ?? 0);
  const max = Math.max(...vals.map(Math.abs), 1);
  const hasNeg = vals.some((v) => v < 0);
  return (
    <div className={`bars ${hasNeg ? "has-neg" : ""}`}>
      {vals.map((v, i) => (
        <div className="bar-col" key={i} title={`${labels[i]}: ${values[i] == null ? "—" : fmt(v)}`}>
          <div className="bar-track">
            <div className={`bar ${v < 0 ? "neg" : ""} ${highlightLast && i === vals.length - 1 ? "last" : ""}`}
                 style={{ height: `${(Math.abs(v) / max) * (hasNeg ? 50 : 100)}%` }} />
          </div>
          <span className="bar-label">{labels[i].replace(/^[A-Z][a-z]{2} 20/, "’")}</span>
        </div>
      ))}
    </div>
  );
}

export function Section({ title, kicker, children, action }: { title: string; kicker?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <div>
          {kicker && <div className="kicker">{kicker}</div>}
          <h2>{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Observations({ items }: { items: { text: string; tone: string }[] | undefined }) {
  if (!items?.length) return null;
  return (
    <ul className="obs">
      {items.map((o, i) => <li key={i} className={`obs-${o.tone}`}>{o.text}</li>)}
    </ul>
  );
}

export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
        <button className="sheet-grip" onClick={onClose} aria-label="Close" />
        {children}
      </div>
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    set((s) => ({ ...s, loading: true, error: undefined }));
    fn().then((data) => live && set({ data, loading: false }), (e) => live && set({ error: String(e.message || e), loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="loading"><span className="dot" /><span className="dot" /><span className="dot" /> {label}</div>;
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div className="error-note">{error}{onRetry && <button className="link" onClick={onRetry}>Retry</button>}</div>;
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="ext">{children}</a>;
}
