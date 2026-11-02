import type { PriceBar } from '@/domain/market';

/**
 * Push-side signal model. A signal is one observed event plus the rule that
 * surfaced it. There is deliberately no numeric "impact score": ranking is
 * by tier (from named rules), then recency, then stable identifiers.
 */

export const TIERS = ['high', 'medium', 'low', 'routine'] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_RANK: Record<Tier, number> = { high: 0, medium: 1, low: 2, routine: 3 };

export const raise = (a: Tier, b: Tier): Tier => (TIER_RANK[a] <= TIER_RANK[b] ? a : b);
export const lower = (t: Tier): Tier => TIERS[Math.min(TIER_RANK[t] + 1, TIERS.length - 1)] as Tier;

export type SignalKind = 'announcement' | 'results' | 'price_move' | 'volume_spike' | 'combination';

export type EvidenceRef =
  | { kind: 'filing'; label: string; url: string; origin: 'exchange_filed' | 'company_issued' | 'unknown' }
  | { kind: 'price_series'; label: string; detail: string };

/** A change between two periods. Growth from a zero or negative base is not meaningful. */
export type Change = { kind: 'ratio'; value: number } | { kind: 'not_meaningful' } | { kind: 'missing' };

export type FirstCutLine = {
  metric: 'revenue' | 'ebitda' | 'pbt' | 'pat';
  label: string;
  /** ₹ for the quarter, the previous quarter and the same quarter a year earlier; null when not available. */
  current: number | null;
  previous: number | null;
  yearAgo: number | null;
  qoq: Change;
  yoy: Change;
  /** Computed from other lines (EBITDA), not printed in the filing. */
  derived: boolean;
  /** Why the quarter's figure is empty, when it is. Only figures that passed the filing's arithmetic checks are shown. */
  note: string | null;
};

/**
 * Headline numbers from one results filing: this quarter against the previous
 * quarter (QoQ) and the same quarter a year earlier (YoY). A results filing
 * prints all three columns, so nothing here comes from another document.
 */
export type ResultsFirstCut = {
  basis: 'consolidated' | 'standalone';
  quarter: { end: string; label: string };
  previousLabel: string;
  yearAgoLabel: string;
  lines: FirstCutLine[];
  /** Page of the filing the figures were read from, and a link straight to it. */
  page: number | null;
  url: string | null;
};

/** A background point about a person, restated from the filing with the verbatim passage that supports it. */
export type PersonFact = { text: string; page: number | null; quote: string };

/**
 * One person whose position changes in a management-change filing. Every entry
 * was checked in code: the announcing quote occurs in the filing and names the
 * person, and each background point's quote occurs in the filing.
 */
export type PersonChange = {
  name: string;
  role: string;
  change: 'appointed' | 'reappointed' | 'redesignated' | 'resigned' | 'retired' | 'ceased';
  /** As printed in the filing, e.g. "12th November 2026". */
  effective: string | null;
  page: number | null;
  quote: string;
  background: PersonFact[];
};

/** Someone taking up a role, as opposed to leaving one. */
export const isIncoming = (p: Pick<PersonChange, 'change'>) => p.change === 'appointed' || p.change === 'reappointed' || p.change === 'redesignated';

/** The explanation every signal carries. Each field is built from the rule and data that produced it. */
export type Explanation = {
  /** What happened, in one sentence, factual. */
  what: string;
  /** Why FINN surfaced it: the rules that set the tier, in order. */
  why: string[];
  /** The rule identifiers that fired, e.g. "category:results", "content:results.intimation", "price.move>=5%". */
  rules: string[];
  evidence: EvidenceRef[];
  /** What FINN does not know about this event. Never empty for market signals. */
  unknowns: string[];
};

export type Signal = {
  /** Stable id derived from the underlying event, so re-ingestion yields the same id. */
  id: string;
  kind: SignalKind;
  companyId: string;
  companyName: string;
  symbol: string;
  tier: Tier;
  /** When the underlying event happened (publication time, or session close for EOD data). UTC ISO. */
  occurredAt: string;
  /** When FINN stored the underlying data. UTC ISO. */
  ingestedAt: string;
  /** For EOD signals, the trading date; null for filings. */
  tradeDate: string | null;
  headline: string;
  category: string | null;
  explanation: Explanation;
  /** Ids of the signals this one combines (combinations only). */
  components: string[];
  /** Suppressed duplicates of this signal (e.g. the same filing listed twice). */
  duplicates: { id: string; headline: string; occurredAt: string }[];
  /** Older than the policy's freshness horizon; ranked after fresh signals of the same tier. */
  stale: boolean;
  /** The headline measurement for market signals: daily change (ratio) or volume multiple. */
  measure: { kind: 'change'; value: number } | { kind: 'multiple'; value: number } | null;
  /** Results signals: the headline numbers read from the filing, when FINN has parsed it. */
  firstCut: ResultsFirstCut | null;
  /** Management-change signals: who changes and their background, read from the filing. */
  people: PersonChange[] | null;
  dataMode: 'live' | 'fixture';
};

export type AnnouncementInputRow = {
  id: string;
  /** Stored document id of the attachment, if registered. */
  documentId: string | null;
  companyId: string;
  companyName: string;
  symbol: string;
  title: string;
  publishedAt: string;
  ingestedAt: string;
  category: string;
  classificationStatus: 'matched' | 'routine' | 'ambiguous' | 'no_match';
  secondary: string[];
  documentUrl: string | null;
  documentOrigin: 'exchange_filed' | 'company_issued' | 'third_party' | 'unverified_external' | null;
  /** Another stored document has identical bytes; the filing duplicates that one. */
  duplicateOfDocument: string | null;
  /** Extracted text of the attachment's first pages, when FINN has downloaded it. */
  attachmentText: string | null;
  /** Headline figures already extracted from this filing, if any. */
  firstCut: ResultsFirstCut | null;
  /** People read from a management-change filing, if FINN has read it. */
  people: PersonChange[] | null;
  dataMode: 'live' | 'fixture';
};

export type BarSeries = {
  companyId: string;
  companyName: string;
  symbol: string;
  listingId: string;
  /** Ascending by trade date; every bar is a completed session. */
  bars: (PriceBar & { lastIngestedAt: string })[];
  dataMode: 'live' | 'fixture';
};
