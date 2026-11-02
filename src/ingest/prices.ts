import type { PriceAdapter } from '@/data/prices/yahoo';
import type { Db } from '@/db/connection';
import { finishFetch, setListingResolution, startFetch, upsertBars, type ListingRow } from '@/db/repositories';

export type PriceIngestSummary = {
  listingId: string;
  providerSymbol: string | null;
  outcome: 'stored' | 'unresolved' | 'unavailable' | 'invalid_payload' | 'unmapped';
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  message: string | null;
};

export function priceRequestKey(providerSymbol: string): string {
  return `prices:${providerSymbol}`;
}

/**
 * Fetches daily bars for each listing and stores completed sessions.
 * Each listing is independent: one unresolved symbol or provider error is
 * recorded and reported, and the rest continue.
 */
export async function ingestPrices(
  db: Db,
  adapter: PriceAdapter,
  listings: ListingRow[],
  opts: { now: () => Date; pauseMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<PriceIngestSummary[]> {
  const out: PriceIngestSummary[] = [];
  for (const [i, listing] of listings.entries()) {
    const symbol = listing.provider_symbol;
    if (!symbol) {
      out.push({ listingId: listing.id, providerSymbol: null, outcome: 'unmapped', inserted: 0, updated: 0, unchanged: 0, rejected: 0, message: 'no provider ticker known for this listing' });
      continue;
    }
    if (i > 0 && opts.pauseMs && opts.sleep) await opts.sleep(opts.pauseMs);
    const started = opts.now();
    const fetchId = startFetch(db, { provider: adapter.provider, dataMode: adapter.dataMode, requestKey: priceRequestKey(symbol), now: started.toISOString() });
    const r = await adapter.fetchDaily(symbol, started);
    const finished = opts.now().toISOString();
    const base = { listingId: listing.id, providerSymbol: symbol, inserted: 0, updated: 0, unchanged: 0, rejected: 0 };

    if (r.status === 'unavailable') {
      finishFetch(db, fetchId, { status: 'unavailable', httpStatus: r.httpStatus, error: r.message, now: finished });
      if (r.reason === 'unresolved_symbol') setListingResolution(db, listing.id, 'unresolved', r.message, finished);
      out.push({ ...base, outcome: r.reason === 'unresolved_symbol' ? 'unresolved' : 'unavailable', message: r.message });
      continue;
    }
    if (r.status === 'invalid_payload') {
      finishFetch(db, fetchId, { status: 'invalid_payload', httpStatus: r.httpStatus, error: r.message, now: finished });
      out.push({ ...base, outcome: 'invalid_payload', message: r.message });
      continue;
    }

    const stored = upsertBars(db, listing.id, r.bars, fetchId, finished);
    const material = r.rejected.filter((x) => x.reason !== 'incomplete_session');
    finishFetch(db, fetchId, {
      status: r.status,
      httpStatus: r.httpStatus,
      itemCount: r.bars.length,
      rejectedCount: material.length,
      error: material.length ? `rejected rows: ${summarize(material.map((x) => x.reason))}` : null,
      now: finished,
    });
    if (r.bars.length > 0) setListingResolution(db, listing.id, 'resolved', null, finished);
    out.push({ ...base, ...stored, rejected: material.length, outcome: 'stored', message: material.length ? summarize(material.map((x) => x.reason)) : null });
  }
  return out;
}

function summarize(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
}
