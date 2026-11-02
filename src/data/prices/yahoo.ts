import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { isCompletedSession, istDateFromEpochSeconds, validateBar, type BarRejection, type PriceBar } from '@/domain/market';

import { defaultHttpDeps, describeHttpError, httpGet, type HttpDeps } from '../http';

/**
 * Yahoo Finance chart endpoint (query1.finance.yahoo.com/v8/finance/chart).
 *
 * Verified 2026-11-01 with a truthful User-Agent: returns daily OHLCV JSON for
 * `.NS` symbols; unknown symbols return HTTP 404 with chart.error.
 * Limitations: unofficial and undocumented, no SLA, may rate-limit or change
 * shape without notice. Data is end-of-day; during market hours the latest
 * bar is a moving intraday value and is dropped (see isCompletedSession).
 */

export type PriceFetchResult =
  | {
      status: 'ok' | 'partial';
      bars: PriceBar[];
      rejected: { index: number; tradeDate: string | null; reason: BarRejection['reason'] | 'duplicate_date' }[];
      httpStatus: number | null;
      fetchedAt: string;
    }
  | { status: 'unavailable'; reason: 'unresolved_symbol' | 'http_error' | 'no_fixture'; httpStatus: number | null; message: string; fetchedAt: string }
  | { status: 'invalid_payload'; message: string; httpStatus: number | null; fetchedAt: string };

export interface PriceAdapter {
  readonly provider: string;
  readonly dataMode: 'live' | 'fixture';
  fetchDaily(providerSymbol: string, now: Date): Promise<PriceFetchResult>;
}

const NullableNumbers = z.array(z.number().nullable());

const ChartResult = z.object({
  meta: z.object({ currency: z.string().nullable().optional(), symbol: z.string(), exchangeTimezoneName: z.string().optional() }),
  timestamp: z.array(z.number().int()).optional(),
  indicators: z.object({
    quote: z.array(z.object({ open: NullableNumbers, high: NullableNumbers, low: NullableNumbers, close: NullableNumbers, volume: NullableNumbers })).min(1),
    adjclose: z.array(z.object({ adjclose: NullableNumbers })).optional(),
  }),
});

const ChartResponse = z.object({
  chart: z.object({
    result: z.array(ChartResult).nullable(),
    error: z.object({ code: z.string(), description: z.string() }).nullable(),
  }),
});

/** Pure parser shared by the live and fixture adapters, so recorded data passes the same validation as live data. */
export function parseYahooChart(json: unknown, expectedSymbol: string, fetchedAt: Date, httpStatus: number | null): PriceFetchResult {
  const at = fetchedAt.toISOString();
  const parsed = ChartResponse.safeParse(json);
  if (!parsed.success) {
    return { status: 'invalid_payload', message: `unexpected chart shape: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim(), httpStatus, fetchedAt: at };
  }
  const { result, error } = parsed.data.chart;
  if (error || !result || result.length === 0) {
    return { status: 'unavailable', reason: 'unresolved_symbol', httpStatus, message: error ? `${error.code}: ${error.description}` : 'empty result', fetchedAt: at };
  }
  const r = result[0];
  if (!r) return { status: 'unavailable', reason: 'unresolved_symbol', httpStatus, message: 'empty result', fetchedAt: at };
  if (r.meta.symbol.toUpperCase() !== expectedSymbol.toUpperCase()) {
    return { status: 'invalid_payload', message: `response is for ${r.meta.symbol}, expected ${expectedSymbol}`, httpStatus, fetchedAt: at };
  }
  if (r.meta.currency && r.meta.currency !== 'INR') {
    return { status: 'invalid_payload', message: `currency ${r.meta.currency} is not INR`, httpStatus, fetchedAt: at };
  }

  const ts = r.timestamp ?? [];
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose?.[0]?.adjclose;
  if (!q) return { status: 'invalid_payload', message: 'no quote series', httpStatus, fetchedAt: at };
  const lengths = [q.open.length, q.high.length, q.low.length, q.close.length, q.volume.length, ...(adj ? [adj.length] : [])];
  if (lengths.some((n) => n !== ts.length)) {
    return { status: 'invalid_payload', message: 'series lengths do not match timestamps', httpStatus, fetchedAt: at };
  }

  const byDate = new Map<string, { bar: PriceBar; index: number }>();
  const rejected: Extract<PriceFetchResult, { status: 'ok' | 'partial' }>['rejected'] = [];
  ts.forEach((epoch, i) => {
    const tradeDate = istDateFromEpochSeconds(epoch);
    if (!isCompletedSession(tradeDate, fetchedAt)) {
      rejected.push({ index: i, tradeDate, reason: 'incomplete_session' });
      return;
    }
    const v = validateBar({ tradeDate, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], adjClose: adj?.[i], volume: q.volume[i] });
    if (!v.ok) {
      rejected.push({ index: i, tradeDate, reason: v.error.reason });
      return;
    }
    const prior = byDate.get(tradeDate);
    if (prior) rejected.push({ index: prior.index, tradeDate, reason: 'duplicate_date' }); // keep the later row
    byDate.set(tradeDate, { bar: v.value, index: i });
  });

  const bars = [...byDate.values()].map((x) => x.bar).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  // Today's in-progress bar is expected noise, not a data-quality problem.
  const material = rejected.filter((x) => x.reason !== 'incomplete_session');
  return { status: material.length === 0 ? 'ok' : 'partial', bars, rejected, httpStatus, fetchedAt: at };
}

export class YahooChartAdapter implements PriceAdapter {
  readonly provider = 'yahoo';
  readonly dataMode = 'live' as const;

  constructor(
    private readonly range: '3mo' | '6mo' | '1y' | '2y' = '1y',
    private readonly deps: HttpDeps = defaultHttpDeps,
  ) {}

  async fetchDaily(providerSymbol: string, now: Date): Promise<PriceFetchResult> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}?range=${this.range}&interval=1d&includeAdjustedClose=true`;
    const res = await httpGet(url, { accept: 'application/json', passStatuses: [404], maxBytes: 2 * 1024 * 1024 }, this.deps);
    if (!res.ok) {
      return { status: 'unavailable', reason: 'http_error', httpStatus: res.error.kind === 'status' ? res.error.status : null, message: describeHttpError(res.error), fetchedAt: now.toISOString() };
    }
    let json: unknown;
    try {
      json = JSON.parse(res.value.body.toString('utf8'));
    } catch {
      // Body is not JSON at all (an HTML error page, a truncated response).
      return { status: 'invalid_payload', message: 'response is not JSON', httpStatus: res.value.status, fetchedAt: now.toISOString() };
    }
    return parseYahooChart(json, providerSymbol, now, res.value.status);
  }
}

/** Recorded Yahoo responses, labelled as demo data. File: <dir>/<providerSymbol>.json = { capturedAt, response }. */
export const RecordedChartSchema = z.object({ capturedAt: z.string().datetime(), source: z.literal('yahoo'), response: z.unknown() });

export class FixturePriceAdapter implements PriceAdapter {
  readonly provider = 'fixture:yahoo';
  readonly dataMode = 'fixture' as const;

  constructor(private readonly dir: string) {}

  async fetchDaily(providerSymbol: string): Promise<PriceFetchResult> {
    const file = path.join(this.dir, `${providerSymbol.replace(/[^A-Za-z0-9.&-]/g, '_')}.json`);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      // No recording for this symbol: unavailable, never synthesized.
      return { status: 'unavailable', reason: 'no_fixture', httpStatus: null, message: `no recorded fixture at ${path.basename(file)}`, fetchedAt: new Date(0).toISOString() };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { status: 'invalid_payload', message: 'fixture file is not JSON', httpStatus: null, fetchedAt: new Date(0).toISOString() };
    }
    const rec = RecordedChartSchema.safeParse(json);
    if (!rec.success) return { status: 'invalid_payload', message: 'fixture file is malformed', httpStatus: null, fetchedAt: new Date(0).toISOString() };
    // Validate as of capture time so the recording behaves exactly as it did live.
    return parseYahooChart(rec.data.response, providerSymbol, new Date(rec.data.capturedAt), 200);
  }
}
