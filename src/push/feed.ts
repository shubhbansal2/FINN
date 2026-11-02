import type { Db } from '@/db/connection';
import { ensureWatchlist, lastFetch, latestTradeDate, listCompanies, listListings } from '@/db/repositories';
import { marketDataStatus } from '@/domain/market';
import { err, ok, type Result } from '@/domain/result';
import { filingsRequestKey } from '@/ingest/filings';
import { priceRequestKey } from '@/ingest/prices';

import { compareSignals, type Digest } from './digest';
import { getDigest } from './service';
import type { Signal } from './types';

/**
 * The signal feed as the UI consumes it: one ranked list across companies,
 * routine filings set aside, and an honest status for each data source.
 */

export type SourceStatus = {
  source: 'prices' | 'filings';
  label: string;
  /** `recorded`: demo fixtures. Their age is the recording's, and they are never "current". */
  state: 'current' | 'stale' | 'partial' | 'unavailable' | 'recorded';
  asOf: string | null;
  detail: string;
  failed: string[];
};

export type FeedItem = { signal: Signal; children: Signal[]; alerted: boolean };

export type Feed = {
  window: Digest['window'];
  generatedAt: string;
  items: FeedItem[];
  routine: Signal[];
  counts: Digest['counts'];
  latestBefore: Digest['latestBefore'];
  notes: string[];
  sources: SourceStatus[];
  watchlist: { label: string; companies: { id: string; name: string; symbol: string }[] };
  dataMode: 'live' | 'fixture';
};

/** Filings are polled; an index older than this is stale. */
const FILINGS_STALE_HOURS = 12;

export function sourceStatuses(db: Db, now: Date, dataMode: 'live' | 'fixture' = 'live'): SourceStatus[] {
  if (dataMode === 'fixture') return recordedStatuses(db);
  ensureWatchlist(db, now.toISOString());
  const listings = listListings(db, { watchlist: true });
  const nse = new Set(listings.filter((l) => l.exchange === 'NSE').map((l) => l.company_id));
  const priced = listings.filter((l) => l.exchange === 'NSE' || !nse.has(l.company_id));
  const states = priced.map((l) => {
    const latest = latestTradeDate(db, l.id);
    const f = l.provider_symbol ? lastFetch(db, priceRequestKey(l.provider_symbol)) : null;
    return { symbol: l.symbol, latest, status: marketDataStatus({ latestTradeDate: latest, lastAttemptOk: f ? f.status === 'ok' || f.status === 'partial' : null, now }) };
  });
  const current = states.filter((s) => s.status === 'eod_delayed' || s.status === 'cached');
  const stale = states.filter((s) => s.status === 'stale');
  const missing = states.filter((s) => s.status === 'unavailable');
  const sessions = current.map((s) => s.latest).filter((d): d is string => !!d).sort();
  const prices: SourceStatus = {
    source: 'prices',
    label: 'End-of-day prices',
    state: states.length === 0 || current.length === 0 ? (stale.length ? 'stale' : 'unavailable') : stale.length || missing.length ? 'partial' : 'current',
    asOf: sessions[sessions.length - 1] ?? stale.map((s) => s.latest).filter((d): d is string => !!d).sort().pop() ?? null,
    detail:
      states.length === 0
        ? 'No listings configured.'
        : `${current.length} of ${states.length} listings current${stale.length ? `; ${stale.length} stale` : ''}${missing.length ? `; ${missing.length} with no data` : ''}.`,
    failed: [...stale, ...missing].map((s) => s.symbol),
  };

  const companies = listCompanies(db, { watchlist: true });
  const fetches = companies.map((c) => ({ c, f: lastFetch(db, filingsRequestKey(c.id)) }));
  const okFetches = fetches.filter((x) => x.f?.status === 'ok' || x.f?.status === 'partial');
  const failedFetches = fetches.filter((x) => !x.f || !(x.f.status === 'ok' || x.f.status === 'partial'));
  const oldest = okFetches.map((x) => x.f?.finished_at ?? '').filter(Boolean).sort()[0] ?? null;
  const ageHours = oldest ? (now.getTime() - Date.parse(oldest)) / 3_600_000 : Infinity;
  const filings: SourceStatus = {
    source: 'filings',
    label: 'Exchange filings',
    state: okFetches.length === 0 ? 'unavailable' : failedFetches.length ? 'partial' : ageHours > FILINGS_STALE_HOURS ? 'stale' : 'current',
    asOf: oldest,
    detail:
      okFetches.length === 0
        ? 'No filings index has been fetched.'
        : `${okFetches.length} of ${companies.length} companies indexed${failedFetches.length ? `; ${failedFetches.length} failed or never fetched` : ''}. Only the ~5 most recent filings per company are visible to FINN.`,
    failed: failedFetches.map((x) => x.c.nseSymbol ?? x.c.id),
  };
  return [prices, filings];
}

/** Demo mode: describe what was recorded and when, without implying it is up to date. */
function recordedStatuses(db: Db): SourceStatus[] {
  const session = (db.prepare(`SELECT MAX(trade_date) AS d FROM price_bar`).get() as { d: string | null }).d;
  const filing = (db.prepare(`SELECT MAX(published_at) AS t FROM announcement`).get() as { t: string | null }).t;
  return [
    { source: 'prices', label: 'End-of-day prices', state: session ? 'recorded' : 'unavailable', asOf: session, detail: 'Recorded fixtures; not refreshed in demo mode.', failed: [] },
    { source: 'filings', label: 'Exchange filings', state: filing ? 'recorded' : 'unavailable', asOf: filing, detail: 'Recorded fixtures; not refreshed in demo mode.', failed: [] },
  ];
}

export function getFeed(db: Db, opts: { window?: string | null; now: Date; dataMode: 'live' | 'fixture' }): Result<Feed, string> {
  const digest = getDigest(db, opts);
  if (!digest.ok) return err(digest.error);
  const d = digest.value;
  const items = d.groups.flatMap((g) => g.items).sort((a, b) => compareSignals(a.signal, b.signal));
  const routine = d.groups.flatMap((g) => g.routine).sort(compareSignals);
  const companies = listCompanies(db, { watchlist: true }).map((c) => ({ id: c.id, name: c.name, symbol: c.nseSymbol ?? c.bseCode ?? c.id }));
  return ok({
    window: d.window,
    generatedAt: d.generatedAt,
    items,
    routine,
    counts: d.counts,
    latestBefore: d.latestBefore,
    notes: d.notes,
    sources: sourceStatuses(db, opts.now, opts.dataMode),
    watchlist: { label: `Watchlist · ${companies.length} ${companies.length === 1 ? 'company' : 'companies'}`, companies },
    dataMode: opts.dataMode,
  });
}
