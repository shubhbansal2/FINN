import { err, ok, type Result } from './result';

/**
 * End-of-day market data. FINN never handles intraday or streaming prices:
 * a bar exists only for a completed trading session.
 */

export type PriceBar = {
  /** Exchange-local trading date, YYYY-MM-DD (IST). */
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Provider's split/dividend-adjusted close; null if the provider did not supply it. */
  adjClose: number | null;
  volume: number;
};

export type BarRejection =
  | { reason: 'missing_field'; field: string }
  | { reason: 'non_finite'; field: string }
  | { reason: 'non_positive_price'; field: string }
  | { reason: 'negative_volume' }
  | { reason: 'inconsistent_range' }
  | { reason: 'incomplete_session' };

type RawBar = {
  tradeDate: string;
  open: number | null | undefined;
  high: number | null | undefined;
  low: number | null | undefined;
  close: number | null | undefined;
  adjClose: number | null | undefined;
  volume: number | null | undefined;
};

const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const;

/** Validates a provider bar. Missing values are rejections, never zeros. */
export function validateBar(raw: RawBar): Result<PriceBar, BarRejection> {
  for (const field of PRICE_FIELDS) {
    const v = raw[field];
    if (v === null || v === undefined) return err({ reason: 'missing_field', field });
    if (!Number.isFinite(v)) return err({ reason: 'non_finite', field });
    if (v <= 0) return err({ reason: 'non_positive_price', field });
  }
  if (raw.volume === null || raw.volume === undefined) return err({ reason: 'missing_field', field: 'volume' });
  if (!Number.isFinite(raw.volume)) return err({ reason: 'non_finite', field: 'volume' });
  if (raw.volume < 0) return err({ reason: 'negative_volume' });

  const open = raw.open as number;
  const high = raw.high as number;
  const low = raw.low as number;
  const close = raw.close as number;
  // Allow 0.5% tolerance: providers round OHLC independently.
  const tol = 0.005 * high;
  if (low > high || open > high + tol || close > high + tol || open < low - tol || close < low - tol) {
    return err({ reason: 'inconsistent_range' });
  }

  const adj = raw.adjClose;
  return ok({
    tradeDate: raw.tradeDate,
    open,
    high,
    low,
    close,
    adjClose: adj !== null && adj !== undefined && Number.isFinite(adj) && adj > 0 ? adj : null,
    volume: Math.round(raw.volume),
  });
}

const IST_OFFSET_MINUTES = 330;
/** NSE/BSE regular session closes at 15:30 IST; EOD figures settle shortly after. */
const SESSION_SETTLED_MINUTES = 16 * 60;

function istParts(instant: Date) {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** IST calendar date for a UTC epoch-seconds timestamp. */
export function istDateFromEpochSeconds(epochSeconds: number): string {
  return istParts(new Date(epochSeconds * 1000)).date;
}

/**
 * A bar for today's date fetched before the session settles is a partial,
 * moving intraday value. FINN drops it rather than presenting it as EOD.
 */
export function isCompletedSession(tradeDate: string, fetchedAt: Date): boolean {
  const now = istParts(fetchedAt);
  if (tradeDate < now.date) return true;
  if (tradeDate > now.date) return false;
  return now.minutes >= SESSION_SETTLED_MINUTES;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * The most recent session whose EOD data should exist at `now`.
 *
 * Limitation: weekends are excluded; exchange holidays are excluded only when
 * supplied. Without a holiday list, data looks stale on a holiday, which errs
 * toward warning rather than toward false confidence.
 */
export function expectedLatestSession(now: Date, holidays: ReadonlySet<string> = new Set()): string {
  const p = istParts(now);
  let date = p.minutes >= SESSION_SETTLED_MINUTES ? p.date : addDays(p.date, -1);
  for (let i = 0; i < 15; i += 1) {
    const wd = weekdayOf(date);
    if (wd !== 0 && wd !== 6 && !holidays.has(date)) return date;
    date = addDays(date, -1);
  }
  throw new Error('No trading session found in the last 15 days; check the holiday list');
}

/**
 * How current a listing's EOD data is.
 * - `eod_delayed`: covers the latest expected session; refreshed in the last successful fetch.
 * - `cached`: covers the latest session, but the most recent fetch attempt failed; served from store.
 * - `stale`: latest stored session is older than the latest expected session.
 * - `unavailable`: nothing stored.
 */
export type MarketDataStatus = 'eod_delayed' | 'cached' | 'stale' | 'unavailable';

export function marketDataStatus(input: {
  latestTradeDate: string | null;
  lastAttemptOk: boolean | null;
  now: Date;
  holidays?: ReadonlySet<string>;
}): MarketDataStatus {
  if (!input.latestTradeDate) return 'unavailable';
  const expected = expectedLatestSession(input.now, input.holidays);
  if (input.latestTradeDate < expected) return 'stale';
  return input.lastAttemptOk === false ? 'cached' : 'eod_delayed';
}

export const MARKET_DATA_STATUS_LABEL: Record<MarketDataStatus, string> = {
  eod_delayed: 'End-of-day (delayed, not real-time)',
  cached: 'Cached end-of-day; last refresh failed',
  stale: 'Stale end-of-day data',
  unavailable: 'No price data',
};
