export type Tone = "pos" | "neg" | "neutral";
export interface Obs { text: string; tone: Tone }

export interface Metric { name: string; value: number | null; qoq?: number | null; yoy?: number | null }
export interface ResultsCard {
  status: "ready" | "pending" | "previous" | "filing";
  period: string; quarter: string; basis?: string; lender?: boolean; unit?: string; source?: string; page?: number;
  metrics?: Metric[]; margins?: Record<string, { value: number; yoy_bps: number }>;
  headline?: string; note?: string; pending_quarter?: string;
}

export interface LlmFiling {
  category: string; materiality: "routine" | "notable" | "material"; summary: string;
  people: { name: string; role: string; change: string; effective_date: string | null; previous_role: string | null; background?: string | null; background_source?: string }[];
  evidence: string; evidence_verified?: boolean;
}
export interface Filing {
  id: string; ts: string; subject: string; text: string; headline: string; url: string;
  category: string; score: number; summary: string | null; reasons: string[]; tag: string | null; llm?: LlmFiling;
}
export interface DigestEvent {
  key: string; symbol: string; name: string; category: string; label: string; score: number; ts: string;
  lead: Filing; related: Filing[]; card?: ResultsCard | null; spark?: number[];
}
export interface Mover { symbol: string; date: string; close: number; move_pct: number; volume: number; vol_x: number | null }
export interface Digest {
  window: { start: string; end: string; hours: number };
  top: DigestEvent[]; glance: DigestEvent[];
  routine: { count: number; groups: { category: string; label: string; items: { symbol: string; text: string; url: string; ts: string; n: number }[] }[] };
  filings_total: number;
  freshness: { filings_until: string; prices_until: string; now: string };
  movers: Mover[]; alerts_unseen: number;
}
export interface Holding { symbol: string; name: string; sector: string; close: number | null; move_pct: number | null; vol_x: number | null; spark: number[] }
export interface Alert { id: string; kind: "volume" | "price" | "filing"; symbol: string; ts: string; title: string; score: number; seen: number; detail: Record<string, unknown> }
export interface Prefs {
  watch_categories: string[]; volume_multiple: number; volume_lookback: number; price_move_pct: number;
  min_alert_score: number; categories?: Record<string, string>;
}

export interface Series { periods: string[]; series: Record<string, (number | null)[]>; observations: Obs[] }
export interface Cards {
  header: {
    symbol: string; name: string; sector: string | null; in_portfolio: boolean; about: string | null;
    ratios: Record<string, string>; website: string | null;
    price: { close: number; date: string; change_pct: number; high_52w: number; low_52w: number; return_1y: number; spark: number[] } | null;
  };
  financial: { basis: string; lender: boolean; metrics: Metric[]; margins: { name: string; value: number }[]; latest_quarter: ResultsCard | null } | null;
  trajectory: (Series & { cagr: Record<string, Record<string, number | null>>; margin_label?: string }) | null;
  balance_sheet: (Series & { lender: boolean; working_capital?: Record<string, (number | null)[] | string[]> }) | null;
  cash: (Series & { lender: boolean; conversion_5y?: number }) | null;
  shareholding: Series | null;
}
export interface Quote { id?: string; call: string; quote: string; page: number | null; source: string; about?: string; verified?: boolean }
export interface GuidanceRow {
  metric: string; label: string; low: number | null; high: number | null; unit: string; period: string; direction: string;
  quote: string; speaker: string; page: number; source: string; call: string; call_quarter: string;
  status: "delivered" | "missed" | "on_track" | "behind" | "pending" | "unscored"; actual?: number; why: string;
  move: "raised" | "cut" | "held" | null; path: { call: string; low: number | null; high: number | null; quote: string; page: number; source: string }[];
}
export interface Analysis {
  guidance?: { items: GuidanceRow[]; counts: Record<string, number>; calls: { period: string; quarter: string; url: string; kind?: "transcript" | "ppt"; tone: string; dropped: number }[];
               themes: { topic: string; management_says: string; quote: string; call: string; page: number; source: string }[]; _at: string };
  business?: { what_it_does: string; segments: { name: string; share_pct: number | null; detail: string; page: number }[];
               facts: { fact: string; page: number }[]; source: string; year: string; _at: string };
  judgement?: { verdict: string; narrative_vs_numbers: { claim: string; verdict: "agrees" | "diverges" | "too_early"; numbers: string; quotes: Quote[] }[];
                bull: { point: string; evidence: string }[]; bear: { point: string; evidence: string }[]; watch: string[]; _at: string };
}
export interface Status { state: "idle" | "running" | "done" | "error" | "disabled"; step?: string; error?: string }
export interface CompanyView { symbol: string; cards: Cards; analysis: Analysis; status: Status; llm: boolean }
export interface Answer { answerable: boolean; answer: string; quotes: Quote[] }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  digest: (hours: number) => req<Digest>(`/api/digest?hours=${hours}`),
  portfolio: () => req<Holding[]>("/api/portfolio"),
  alerts: () => req<Alert[]>("/api/alerts"),
  seen: () => req("/api/alerts/seen", { method: "POST" }),
  prefs: () => req<Prefs>("/api/prefs"),
  savePrefs: (p: Prefs) => req<{ new_alerts: number }>("/api/prefs", { method: "PUT", body: JSON.stringify(p) }),
  search: (q: string) => req<{ symbol: string; name: string | null; in_portfolio: number; new?: boolean }[]>(`/api/search?q=${encodeURIComponent(q)}`),
  company: (s: string) => req<CompanyView>(`/api/company/${encodeURIComponent(s)}`),
  research: (s: string, force = false) => req<Status>(`/api/research/${encodeURIComponent(s)}?force=${force}`, { method: "POST" }),
  status: (s: string) => req<Status>(`/api/research/${encodeURIComponent(s)}/status`),
  ask: (s: string, question: string) => req<Answer>(`/api/ask/${encodeURIComponent(s)}`, { method: "POST", body: JSON.stringify({ question }) }),
};
