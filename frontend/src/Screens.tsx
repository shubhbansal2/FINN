import { FormEvent, useEffect, useState } from "react";
import { Alert, api, Prefs } from "./api";
import { ago, ErrorNote, Loading, num, pct, Section, Spark, tone, useAsync } from "./ui";

// ---- Portfolio ---------------------------------------------------------------------------------

export function Portfolio({ go }: { go: (p: string) => void }) {
  const { data, error, loading, reload } = useAsync(api.portfolio, []);
  const [sort, setSort] = useState<"move" | "name">("move");
  const rows = [...(data || [])].sort((a, b) =>
    sort === "name" ? a.symbol.localeCompare(b.symbol) : Math.abs(b.move_pct ?? 0) - Math.abs(a.move_pct ?? 0));
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display">Portfolio</h1>
        <div className="chips">
          <button className={`chip ${sort === "move" ? "on" : ""}`} onClick={() => setSort("move")}>Biggest moves</button>
          <button className={`chip ${sort === "name" ? "on" : ""}`} onClick={() => setSort("name")}>A–Z</button>
        </div>
      </header>
      {loading && !data && <Loading />}
      {error && <ErrorNote error={error} onRetry={reload} />}
      <div className="list-card">
        {rows.map((h) => (
          <button key={h.symbol} className="holding" onClick={() => go(`/c/${h.symbol}`)}>
            <div className="h-name"><span className="sym">{h.symbol}</span><span className="muted">{h.sector}</span></div>
            <Spark data={h.spark} w={64} h={22} />
            <div className="h-px">
              <span>₹{num(h.close, 1)}</span>
              <span className={`move ${tone(h.move_pct)}`}>{pct(h.move_pct, 2)}</span>
            </div>
            {h.vol_x != null && h.vol_x >= 1.5 && <span className="volx">{h.vol_x.toFixed(1)}×</span>}
          </button>
        ))}
      </div>
      <p className="footnote">End-of-day prices from the last completed session.</p>
    </div>
  );
}

// ---- Research search -----------------------------------------------------------------------------

const RECENT = "finn.recent";
const DEMO = ["TRENT", "HAL", "DMART", "ASIANPAINT"];

export function Research({ go }: { go: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ symbol: string; name: string | null; in_portfolio: number; new?: boolean }[]>([]);
  const recent: string[] = (() => { try { return JSON.parse(localStorage.getItem(RECENT) || "[]"); } catch { return []; } })();

  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    const t = window.setTimeout(() => api.search(q).then(setHits).catch(() => setHits([])), 150);
    return () => clearTimeout(t);
  }, [q]);

  const open = (s: string) => {
    try { localStorage.setItem(RECENT, JSON.stringify([s, ...recent.filter((r) => r !== s)].slice(0, 6))); } catch { /* ignore */ }
    go(`/c/${s}`);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (q.trim()) open(hits[0]?.symbol || q.trim().toUpperCase()); };

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display">Research</h1>
        <p className="muted">Any NSE company. Numbers in seconds; management's track record from their own calls.</p>
      </header>
      <form className="search" onSubmit={submit}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticker or company, e.g. TRENT" aria-label="Search companies"
               autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
      </form>
      {hits.length > 0 && (
        <div className="list-card">
          {hits.map((h) => (
            <button key={h.symbol} className="hit" onClick={() => open(h.symbol)}>
              <span className="sym">{h.symbol}</span>
              <span className="muted">{h.new ? "Look up on NSE →" : h.name}</span>
              {h.in_portfolio ? <span className="badge in">Held</span> : null}
            </button>
          ))}
        </div>
      )}
      {!q && (
        <>
          {recent.length > 0 && <Section title="Recent"><div className="chips wrap">{recent.map((s) => <button key={s} className="chip" onClick={() => open(s)}>{s}</button>)}</div></Section>}
          <Section title="Try" kicker="Outside the portfolio">
            <div className="chips wrap">{DEMO.map((s) => <button key={s} className="chip" onClick={() => open(s)}>{s}</button>)}</div>
          </Section>
        </>
      )}
    </div>
  );
}

// ---- Alerts & rules -------------------------------------------------------------------------------

const KIND_ICON: Record<Alert["kind"], string> = { volume: "▮▮", price: "↕", filing: "§" };

export function Alerts({ go }: { go: (p: string) => void }) {
  const alerts = useAsync(api.alerts, []);
  const [tab, setTab] = useState<"feed" | "rules">("feed");
  useEffect(() => { api.seen().catch(() => undefined); }, []);
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display">Alerts</h1>
        <div className="chips">
          <button className={`chip ${tab === "feed" ? "on" : ""}`} onClick={() => setTab("feed")}>Triggered</button>
          <button className={`chip ${tab === "rules" ? "on" : ""}`} onClick={() => setTab("rules")}>Your rules</button>
        </div>
      </header>
      {tab === "feed" && (
        <>
          {alerts.loading && !alerts.data && <Loading />}
          {alerts.error && <ErrorNote error={alerts.error} onRetry={alerts.reload} />}
          {alerts.data?.length === 0 && <div className="empty"><h3>Quiet week</h3><p>Nothing crossed your thresholds.</p></div>}
          <div className="list-card">
            {alerts.data?.map((a) => (
              <button key={a.id} className={`alert-row k-${a.kind} ${a.seen ? "" : "unseen"}`} onClick={() => go(`/c/${a.symbol}`)}>
                <span className="alert-icon" aria-hidden>{KIND_ICON[a.kind]}</span>
                <span className="alert-title">{a.title}</span>
                <span className="when">{ago(a.ts)}</span>
              </button>
            ))}
          </div>
          <NotifyToggle />
        </>
      )}
      {tab === "rules" && <Rules onSaved={alerts.reload} />}
    </div>
  );
}

function NotifyToggle() {
  const supported = "Notification" in window;
  const [perm, setPerm] = useState(supported ? Notification.permission : "denied");
  if (!supported) return null;
  if (perm === "granted") return <p className="footnote">Phone notifications on: new alerts are pushed when the app checks in.</p>;
  return (
    <button className="btn ghost wide" onClick={async () => setPerm(await Notification.requestPermission())}>
      Notify me on this device
    </button>
  );
}

function Rules({ onSaved }: { onSaved: () => void }) {
  const { data, error } = useAsync(api.prefs, []);
  const [p, setP] = useState<Prefs | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => { if (data) setP(data); }, [data]);
  if (error) return <ErrorNote error={error} />;
  if (!p) return <Loading />;
  const cats = Object.entries(p.categories || {}).filter(([k]) => k !== "unclassified");
  const save = async () => {
    const { categories: _omit, ...body } = p;
    void _omit;
    const r = await api.savePrefs(body as Prefs);
    setSaved(r.new_alerts ? `Saved · ${r.new_alerts} new alert${r.new_alerts > 1 ? "s" : ""}` : "Saved");
    onSaved();
    window.setTimeout(() => setSaved(null), 2500);
  };
  return (
    <div className="rules">
      <Section title="Unusual volume" kicker="Alert when a day's volume exceeds">
        <div className="slider">
          <input type="range" min={1.5} max={6} step={0.25} value={p.volume_multiple}
                 onChange={(e) => setP({ ...p, volume_multiple: Number(e.target.value) })} aria-label="Volume multiple" />
          <output>{p.volume_multiple.toFixed(2)}× the {p.volume_lookback}-day average</output>
        </div>
      </Section>
      <Section title="Price move" kicker="Alert when a stock closes up or down more than">
        <div className="slider">
          <input type="range" min={1} max={15} step={0.5} value={p.price_move_pct}
                 onChange={(e) => setP({ ...p, price_move_pct: Number(e.target.value) })} aria-label="Price move percent" />
          <output>±{p.price_move_pct}% in a day</output>
        </div>
      </Section>
      <Section title="Filings I care about" kicker="Material filings of these types alert you and rank higher in the brief">
        <div className="toggles">
          {cats.map(([k, label]) => {
            const on = p.watch_categories.includes(k);
            return (
              <button key={k} className={`toggle ${on ? "on" : ""}`} aria-pressed={on}
                      onClick={() => setP({ ...p, watch_categories: on ? p.watch_categories.filter((c) => c !== k) : [...p.watch_categories, k] })}>
                {label}
              </button>
            );
          })}
        </div>
      </Section>
      <button className="btn wide" onClick={save}>{saved || "Save rules"}</button>
    </div>
  );
}
