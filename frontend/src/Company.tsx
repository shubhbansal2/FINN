import { FormEvent, useEffect, useState } from "react";
import { Analysis, Answer, api, CompanyView, GuidanceRow, Quote, Status } from "./api";
import { ResultsBlock } from "./EventCard";
import { Bars, cr, ErrorNote, Ext, Loading, num, Observations, pct, Section, Spark, tone, useAsync } from "./ui";

const STATUS_LABEL: Record<GuidanceRow["status"], string> = {
  delivered: "Delivered", missed: "Missed", on_track: "On track", behind: "Behind", pending: "Pending", unscored: "Not checkable",
};

export function Company({ symbol, go }: { symbol: string; go: (p: string) => void }) {
  const { data, error, loading, reload } = useAsync(() => api.company(symbol), [symbol]);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => { setStatus(data?.status ?? null); }, [data]);
  // Poll while the background research run is going; reload when it lands.
  useEffect(() => {
    if (status?.state !== "running") return;
    const t = window.setInterval(async () => {
      const s = await api.status(symbol).catch(() => null);
      if (!s) return;
      setStatus(s);
      if (s.state !== "running") reload();
    }, 2500);
    return () => clearInterval(t);
  }, [status?.state, symbol, reload]);

  if (loading && !data) return <div className="page"><Loading label={`Pulling ${symbol}'s statements`} /></div>;
  if (error) return <div className="page"><ErrorNote error={error} onRetry={reload} /></div>;
  if (!data) return null;
  const { cards, analysis } = data;
  const h = cards.header;
  const start = async (force = false) => setStatus(await api.research(symbol, force));

  return (
    <div className="page company">
      <button className="back" onClick={() => history.length > 1 ? history.back() : go("/research")}>‹ Back</button>
      <header className="co-head">
        <div className="kicker">{h.sector?.split(" > ").slice(-1)[0]}{h.in_portfolio && <span className="badge in">In portfolio</span>}</div>
        <h1 className="display">{h.name}</h1>
        {h.price && (
          <div className="quote">
            <span className="px">₹{num(h.price.close, 2)}</span>
            <span className={`move ${tone(h.price.change_pct)}`}>{pct(h.price.change_pct, 2)}</span>
            <span className="muted">1y {pct(h.price.return_1y)}</span>
          </div>
        )}
        {h.price && <Spark data={h.price.spark} w={340} h={56} strokeWidth={1.75} />}
        {h.price && <Range lo={h.price.low_52w} hi={h.price.high_52w} v={h.price.close} />}
        <div className="ratios">
          {["Market Cap", "Stock P/E", "ROCE", "ROE", "Dividend Yield"].filter((k) => h.ratios[k]).map((k) => (
            <span key={k} className="ratio"><span className="muted">{k.replace("Stock ", "")}</span> {h.ratios[k].replace("₹ ", "₹")}</span>
          ))}
        </div>
      </header>

      <nav className="jump">
        {[["verdict", "Verdict"], ["guidance", "Promised vs delivered"], ["numbers", "Numbers"], ["business", "Business"], ["ask", "Ask"]].map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }}>{label}</a>
        ))}
      </nav>

      <ResearchState data={data} status={status} onStart={start} />
      <Verdict a={analysis} />
      <Guidance a={analysis} />
      <Judgement a={analysis} />
      <Numbers data={data} />
      <Business a={analysis} about={h.about} />
      <Themes a={analysis} />
      <Ask symbol={symbol} enabled={data.llm} />
      <Sources a={analysis} />
    </div>
  );
}

function Range({ lo, hi, v }: { lo: number; hi: number; v: number }) {
  const p = Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100));
  return (
    <div className="range" aria-label="52-week range">
      <span>₹{num(lo)}</span>
      <div className="range-track"><div className="range-dot" style={{ left: `${p}%` }} /></div>
      <span>₹{num(hi)}</span>
    </div>
  );
}

function ResearchState({ data, status, onStart }: { data: CompanyView; status: Status | null; onStart: (force?: boolean) => void }) {
  const has = !!data.analysis.judgement;
  if (!data.llm) {
    return (
      <div className="notice" id="verdict">
        <strong>Numbers below are live.</strong> Reading the transcripts and annual report needs a free
        Gemini API key on the server (<code>GEMINI_API_KEY</code>).
      </div>
    );
  }
  if (status?.state === "running") {
    return <div className="notice running" id="verdict"><span className="spinner" /> {status.step || "Working"}…</div>;
  }
  if (status?.state === "error") {
    return <div className="notice error" id="verdict">Analysis failed: {status.error} <button className="link" onClick={() => onStart(true)}>Retry</button></div>;
  }
  if (!has) {
    return (
      <div className="cta" id="verdict">
        <div>
          <strong>Hold management to their word.</strong>
          <p>Read the last four earnings calls and the latest annual report: what was promised, what was delivered.</p>
        </div>
        <button className="btn" onClick={() => onStart()}>Analyse</button>
      </div>
    );
  }
  return null;
}

function Verdict({ a }: { a: Analysis }) {
  if (!a.judgement) return null;
  return (
    <section className="verdict" id="verdict">
      <div className="kicker">Can you take management at their word?</div>
      <p>{a.judgement.verdict}</p>
    </section>
  );
}

/** One quote is evidence; five near-identical ones are noise. The rest stay one tap away. */
function Quotes({ quotes }: { quotes: Quote[] }) {
  const [all, setAll] = useState(false);
  if (!quotes.length) return null;
  const shown = all ? quotes : quotes.slice(0, 1);
  return (
    <>
      {shown.map((q, k) => <QuoteLine key={k} q={q} />)}
      {quotes.length > 1 && (
        <button className="link more" onClick={() => setAll(!all)}>
          {all ? "Fewer quotes" : `+${quotes.length - 1} more quote${quotes.length > 2 ? "s" : ""}`}
        </button>
      )}
    </>
  );
}

function Judgement({ a }: { a: Analysis }) {
  const j = a.judgement;
  if (!j) return null;
  return (
    <>
      <Section title="Story vs numbers" kicker="Where management and the financials agree or diverge">
        <div className="checks">
          {j.narrative_vs_numbers.map((c, i) => (
            <div key={i} className={`check v-${c.verdict}`}>
              <div className="check-head">
                <span className={`pill v-${c.verdict}`}>{c.verdict === "agrees" ? "Holds up" : c.verdict === "diverges" ? "Diverges" : "Too early"}</span>
                <span className="claim">{c.claim}</span>
              </div>
              <p className="check-numbers">{c.numbers}</p>
              <Quotes quotes={c.quotes} />
            </div>
          ))}
        </div>
      </Section>
      <div className="bullbear">
        <Section title="Bull case">
          <ol className="points pos">{j.bull.map((p, i) => <li key={i}><strong>{p.point}</strong><span>{p.evidence}</span></li>)}</ol>
        </Section>
        <Section title="Bear case">
          <ol className="points neg">{j.bear.map((p, i) => <li key={i}><strong>{p.point}</strong><span>{p.evidence}</span></li>)}</ol>
        </Section>
      </div>
      {j.watch.length > 0 && (
        <div className="watch"><div className="kicker">Watch next quarter</div><ul>{j.watch.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
      )}
    </>
  );
}

function QuoteLine({ q }: { q: Quote }) {
  return (
    <blockquote className="q">
      “{q.quote}”
      <cite>{q.call} call{q.page ? `, p.${q.page}` : ""} {q.source && <Ext href={`${q.source}${q.page ? `#page=${q.page}` : ""}`}>source</Ext>}
        {q.verified === false && <span className="unverified"> · not found verbatim</span>}</cite>
    </blockquote>
  );
}

function guided(r: { low: number | null; high: number | null; unit: string; direction?: string }) {
  const u = r.unit === "%" ? "%" : r.unit === "₹ Cr" ? " Cr" : ` ${r.unit}`;
  if (r.low != null && r.high != null && r.low !== r.high) return `${num(r.low, 1)}–${num(r.high, 1)}${u}`;
  const v = r.low ?? r.high;
  if (v == null) return r.direction ?? "—";
  return `${r.direction === "at_least" ? "≥" : r.direction === "at_most" ? "≤" : ""}${num(v, 1)}${u}`;
}

function Guidance({ a }: { a: Analysis }) {
  const g = a.guidance;
  const [open, setOpen] = useState<number | null>(null);
  const [showUnscored, setShowUnscored] = useState(false);
  if (!g) return null;
  const order: GuidanceRow["status"][] = ["delivered", "on_track", "behind", "missed", "pending", "unscored"];
  const unscored = g.items.filter((r) => r.status === "unscored").length;
  const scored = g.items.length - unscored;
  return (
    <Section title="Promised vs delivered" kicker={`Guidance from ${g.calls.length} ${g.calls[0]?.kind === "ppt" ? "investor presentations (no call transcripts published)" : "earnings calls"}, checked against reported results`}>
      <div id="guidance" className="score-summary">
        {order.filter((s) => g.counts[s]).map((s) => <span key={s} className={`pill s-${s}`}>{g.counts[s]} {STATUS_LABEL[s].toLowerCase()}</span>)}
      </div>
      {g.items.length === 0 && <p className="muted">Management gave no quantified guidance on these calls.</p>}
      <div className="guidance">
        {g.items.map((r, i) => (r.status === "unscored" && !showUnscored && scored > 0) ? null : (
          <div key={i} className={`g-row s-${r.status}`}>
            <button className="g-main" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              <span className="g-label">{r.label}</span>
              <span className="g-guided">{guided(r)}</span>
              <span className={`pill s-${r.status}`}>{STATUS_LABEL[r.status]}</span>
            </button>
            <div className="g-sub">
              {r.actual != null && <span>Actual <strong>{num(r.actual, 1)}%</strong></span>}
              {r.move && r.move !== "held" && <span className={`move-tag ${r.move}`}>Guidance {r.move} {r.path.map((p) => guided({ ...p, unit: r.unit })).join(" → ")}</span>}
              {r.move === "held" && <span className="move-tag held">Reiterated on {r.path.length} calls</span>}
              <span className="muted">{r.why}</span>
            </div>
            {open === i && (
              <div className="g-quotes">
                {r.path.map((p, k) => <QuoteLine key={k} q={{ call: p.call, quote: p.quote, page: p.page, source: p.source }} />)}
              </div>
            )}
          </div>
        ))}
      </div>
      {unscored > 0 && scored > 0 && (
        <button className="routine-toggle g-more" onClick={() => setShowUnscored(!showUnscored)} aria-expanded={showUnscored}>
          <span>{showUnscored ? "Hide" : "Show"} {unscored} target{unscored > 1 ? "s" : ""} that can't be checked against the statements</span>
          <span className={`chev ${showUnscored ? "open" : ""}`}>›</span>
        </button>
      )}
    </Section>
  );
}

function Numbers({ data }: { data: CompanyView }) {
  const { financial: f, trajectory: t, balance_sheet: b, cash: c, shareholding: s } = data.cards;
  return (
    <div id="numbers">
      {f && (
        <Section title="Financial snapshot" kicker="Trailing twelve months">
          <div className="metric-grid">
            {f.metrics.map((m) => <div key={m.name} className="metric"><span className="muted">{m.name}</span><strong>{cr(m.value)}</strong></div>)}
            {f.margins.map((m) => <div key={m.name} className="metric"><span className="muted">{m.name}</span><strong>{num(m.value, 1)}%</strong></div>)}
          </div>
          {f.latest_quarter && <ResultsBlock card={f.latest_quarter} compact />}
        </Section>
      )}
      {t && (
        <Section title="Trajectory" kicker="What's growing, what's compressing">
          <div className="cagr">
            {Object.entries(t.cagr).map(([k, v]) => (
              <div key={k}><span className="muted">{k} CAGR</span> {["3y", "5y", "10y"].map((p) => <span key={p} className="cagr-cell"><em>{p}</em> {v[p] == null ? "—" : `${v[p]}%`}</span>)}</div>
            ))}
          </div>
          <div className="chart-pair">
            <div><div className="chart-title">Revenue</div><Bars labels={t.periods} values={t.series.Revenue} fmt={(v) => cr(v)} /></div>
            <div><div className="chart-title">PAT</div><Bars labels={t.periods} values={t.series.PAT} fmt={(v) => cr(v)} /></div>
          </div>
          {t.series["Margin %"] && !data.cards.financial?.lender && (
            <div><div className="chart-title">{t.margin_label}</div><Bars labels={t.periods} values={t.series["Margin %"]} fmt={(v) => `${v}%`} /></div>
          )}
          <Observations items={t.observations} />
        </Section>
      )}
      {b && (
        <Section title="Balance sheet" kicker={b.lender ? "Funding and leverage" : "Debt, leverage, working capital"}>
          <div className="chart-pair">
            <div><div className="chart-title">{b.lender ? "Deposits" : "Borrowings"}</div><Bars labels={b.periods} values={b.lender ? b.series.Deposits : b.series.Borrowings} fmt={(v) => cr(v)} /></div>
            <div><div className="chart-title">Debt / equity</div><Bars labels={b.periods} values={b.series["Debt / Equity"]} fmt={(v) => `${v}×`} /></div>
          </div>
          {b.working_capital && (
            <table className="wc">
              <thead><tr><th>Days</th>{(b.working_capital.periods as string[]).map((p) => <th key={p}>{p.slice(-4)}</th>)}</tr></thead>
              <tbody>
                {Object.entries(b.working_capital).filter(([k]) => k !== "periods").map(([k, v]) => (
                  <tr key={k} className={k === "Cash Conversion Cycle" ? "strong" : ""}>
                    <th scope="row">{k.replace(" Days", "").replace("Cash Conversion Cycle", "Cash cycle")}</th>
                    {(v as (number | null)[]).map((x, i) => <td key={i} className="num">{num(x)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Observations items={b.observations} />
        </Section>
      )}
      {c && (
        <Section title="Cash quality" kicker="Do profits turn into cash?">
          {!c.lender && (
            <div className="chart-pair">
              <div><div className="chart-title">Operating cash flow</div><Bars labels={c.periods} values={c.series.CFO} fmt={(v) => cr(v)} /></div>
              <div><div className="chart-title">Free cash flow</div><Bars labels={c.periods} values={c.series.FCF} fmt={(v) => cr(v)} /></div>
            </div>
          )}
          {c.conversion_5y != null && <div className="big-stat"><strong>{c.conversion_5y}%</strong><span>of 5-year profit converted to operating cash</span></div>}
          <Observations items={c.observations} />
        </Section>
      )}
      {s && s.observations.length > 0 && (
        <Section title="Shareholding"><Observations items={s.observations} /></Section>
      )}
    </div>
  );
}

function Business({ a, about }: { a: Analysis; about: string | null }) {
  const b = a.business;
  return (
    <div id="business">
      <Section title="Business" kicker={b ? `From the ${b.year} annual report` : "Company profile"}>
        {b ? (
          <>
            <p className="lede">{b.what_it_does}</p>
            {b.segments.length > 0 && (
              <ul className="segments">
                {b.segments.map((s, i) => (
                  <li key={i}>
                    <div className="seg-head"><strong>{s.name}</strong>{s.share_pct != null && <span>{s.share_pct}%</span>}</div>
                    {s.share_pct != null && <div className="seg-bar"><div style={{ width: `${Math.min(100, s.share_pct)}%` }} /></div>}
                    <p>{s.detail} <Ext href={`${b.source}#page=${s.page}`}>p.{s.page}</Ext></p>
                  </li>
                ))}
              </ul>
            )}
            {b.facts.length > 0 && <ul className="facts">{b.facts.map((f, i) => <li key={i}>{f.fact} <Ext href={`${b.source}#page=${f.page}`}>p.{f.page}</Ext></li>)}</ul>}
          </>
        ) : about ? <p className="lede muted-text">{about}</p> : <p className="muted">No profile yet.</p>}
      </Section>
    </div>
  );
}

function Themes({ a }: { a: Analysis }) {
  const g = a.guidance;
  if (!g?.themes?.length) return null;
  return (
    <Section title="What analysts pressed on" kicker="Recurring themes across the calls">
      <ul className="themes">
        {g.themes.slice(0, 8).map((t, i) => (
          <li key={i}>
            <div className="theme-head"><strong>{t.topic}</strong><span className="muted">{t.call}</span></div>
            <p>{t.management_says}</p>
          </li>
        ))}
      </ul>
      {g.calls.some((c) => c.tone) && (
        <div className="tones">{g.calls.map((c) => c.tone && <div key={c.period}><span className="muted">{c.quarter}</span> {c.tone}</div>)}</div>
      )}
    </Section>
  );
}

const SUGGESTED = ["What did management say about margins?", "Any change in capex plans?", "What are the main risks they flagged?"];

function Ask({ symbol, enabled }: { symbol: string; enabled: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<{ q: string; a?: Answer; err?: string }[]>([]);
  const submit = async (e?: FormEvent, text = q) => {
    e?.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setQ("");
    setThread((t) => [...t, { q: text }]);
    try {
      const a = await api.ask(symbol, text);
      setThread((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a } : x)));
    } catch (err) {
      setThread((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, err: String((err as Error).message) } : x)));
    }
    setBusy(false);
  };
  return (
    <div id="ask">
      <Section title={`Ask about ${symbol}`} kicker="Answered only from the last two call transcripts and reported figures">
        {!enabled && <p className="muted">Needs a free <code>GEMINI_API_KEY</code> on the server.</p>}
        {thread.map((t, i) => (
          <div key={i} className="qa">
            <p className="qa-q">{t.q}</p>
            {!t.a && !t.err && <Loading label="Reading the transcripts" />}
            {t.err && <ErrorNote error={t.err} />}
            {t.a && (
              <div className={`qa-a ${t.a.answerable ? "" : "na"}`}>
                <p>{t.a.answer}</p>
                <Quotes quotes={t.a.quotes} />
              </div>
            )}
          </div>
        ))}
        {enabled && thread.length === 0 && (
          <div className="suggest">{SUGGESTED.map((s) => <button key={s} className="chip" onClick={() => submit(undefined, s)}>{s}</button>)}</div>
        )}
        {enabled && (
          <form className="ask-form" onSubmit={submit}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question…" maxLength={500} aria-label="Question" />
            <button className="btn" disabled={busy || !q.trim()}>Ask</button>
          </form>
        )}
      </Section>
    </div>
  );
}

function Sources({ a }: { a: Analysis }) {
  const calls = a.guidance?.calls || [];
  if (!calls.length && !a.business) return null;
  const dropped = calls.reduce((s, c) => s + (c.dropped || 0), 0);
  return (
    <footer className="sources">
      <div className="kicker">Primary sources</div>
      <ul>
        {calls.map((c) => <li key={c.url}><Ext href={c.url}>{c.quarter} {c.kind === "ppt" ? "investor presentation" : "earnings call transcript"} ({c.period})</Ext></li>)}
        {a.business && <li><Ext href={a.business.source}>Annual report {a.business.year}</Ext></li>}
      </ul>
      <p className="footnote">
        Every quote above was matched verbatim against its source{dropped ? `; ${dropped} extracted item${dropped > 1 ? "s" : ""} that couldn't be matched were discarded` : ""}.
        No news, broker notes or model background knowledge are used.
      </p>
    </footer>
  );
}
