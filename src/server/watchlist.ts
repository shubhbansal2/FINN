import 'server-only';

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { Db } from '@/db/connection';
import { ensureWatchlist, getBars, lastFetch, listCompanies, listListings } from '@/db/repositories';
import { marketDataStatus, MARKET_DATA_STATUS_LABEL, type MarketDataStatus } from '@/domain/market';
import { priceRequestKey } from '@/ingest/prices';
import { dailyReturn } from '@/push/anomalies';
import { getFeed } from '@/push/feed';
import { loadPolicy } from '@/push/policy';
import type { Tier } from '@/push/types';
import { latestReport } from '@/research/engine';

export type WatchlistRow = {
  id: string;
  name: string;
  symbol: string;
  exchange: 'NSE' | 'BSE' | null;
  role: string;
  /** `recorded`: demo fixtures, which are never refreshed, so neither current nor stale. */
  price:
    | { session: string; close: number; change: number | null; changeNote: string | null; status: MarketDataStatus | 'recorded'; statusLabel: string }
    | { session: null; status: 'unavailable'; statusLabel: string };
  signals: { count: number; material: number; top: { headline: string; tier: Tier; occurredAt: string } | null };
  research: { kind: 'stored'; generatedAt: string; status: 'complete' | 'partial' } | { kind: 'demo' } | { kind: 'none' };
};

export type Watchlist = {
  rows: WatchlistRow[];
  available: { id: string; name: string; symbol: string }[];
  signalWindow: string;
  feedError: string | null;
};

const demoReportExists = (companyId: string) => existsSync(path.join(process.cwd(), 'fixtures', 'research', `${companyId.replace(/[^a-z0-9]+/gi, '_')}.json`));

/**
 * One row per watchlist company: last end-of-day close, signals in the last
 * seven days, and whether research exists. Each part degrades on its own.
 */
export function getWatchlist(db: Db, opts: { now: Date; dataMode: 'live' | 'fixture' }): Watchlist {
  ensureWatchlist(db, opts.now.toISOString());
  const companies = listCompanies(db, { watchlist: true });
  const listings = listListings(db, { watchlist: true });
  const all = listCompanies(db);
  const policy = loadPolicy();

  const feed = getFeed(db, { window: '7d', now: opts.now, dataMode: opts.dataMode });
  const signals = feed.ok ? [...feed.value.items.map((i) => i.signal), ...feed.value.routine] : [];

  const rows = companies.map((c): WatchlistRow => {
    const own = listings.filter((l) => l.company_id === c.id);
    const listing = own.find((l) => l.exchange === 'NSE') ?? own[0];
    let price: WatchlistRow['price'] = { session: null, status: 'unavailable', statusLabel: 'No price data' };
    if (listing) {
      const bars = getBars(db, listing.id, { limit: 2 });
      const last = bars[bars.length - 1];
      const prev = bars.length > 1 ? bars[0] : undefined;
      if (last) {
        const f = listing.provider_symbol ? lastFetch(db, priceRequestKey(listing.provider_symbol)) : null;
        const status = opts.dataMode === 'fixture' ? 'recorded' : marketDataStatus({ latestTradeDate: last.tradeDate, lastAttemptOk: f ? f.status === 'ok' || f.status === 'partial' : null, now: opts.now });
        // The same 1D change the price-move signals use (series, gap rule, corporate-action note).
        const series = { companyId: c.id, companyName: c.name, symbol: listing.symbol, listingId: listing.id, bars, dataMode: opts.dataMode };
        const r = prev ? dailyReturn(series, bars.length - 1, policy.prices) : null;
        price = {
          session: last.tradeDate,
          close: last.close,
          change: r?.ok ? r.value : null,
          changeNote: r === null ? 'only one session stored' : r.ok ? (r.notes[0] ?? null) : r.reason,
          status,
          statusLabel: status === 'recorded' ? 'Recorded demo data; not refreshed' : MARKET_DATA_STATUS_LABEL[status],
        };
      }
    }
    const mine = signals.filter((s) => s.companyId === c.id);
    const ranked = mine.filter((s) => s.tier !== 'routine');
    const top = ranked[0] ?? mine[0];
    const stored = opts.dataMode === 'live' ? latestReport(db, c.id) : null;
    return {
      id: c.id,
      name: c.name,
      symbol: c.nseSymbol ?? c.bseCode ?? c.id,
      exchange: listing ? listing.exchange : null,
      role: c.role,
      price,
      signals: { count: mine.length, material: mine.filter((s) => s.tier === 'high' || s.tier === 'medium').length, top: top ? { headline: top.headline, tier: top.tier, occurredAt: top.occurredAt } : null },
      research: stored ? { kind: 'stored', generatedAt: stored.generatedAt, status: stored.status } : opts.dataMode === 'fixture' && demoReportExists(c.id) ? { kind: 'demo' } : { kind: 'none' },
    };
  });

  const on = new Set(companies.map((c) => c.id));
  return {
    rows,
    available: all.filter((c) => !on.has(c.id)).map((c) => ({ id: c.id, name: c.name, symbol: c.nseSymbol ?? c.bseCode ?? c.id })),
    signalWindow: 'Last 7 days',
    feedError: feed.ok ? null : feed.error,
  };
}
