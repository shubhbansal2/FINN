import { describe, expect, it } from 'vitest';

import { expectedLatestSession, isCompletedSession, istDateFromEpochSeconds, marketDataStatus, validateBar } from './market';

const bar = { tradeDate: '2026-10-30', open: 100, high: 105, low: 99, close: 104, adjClose: 104, volume: 1000 };

describe('validateBar', () => {
  it('accepts a sane bar', () => {
    expect(validateBar(bar)).toEqual({ ok: true, value: bar });
  });

  it.each([
    [{ close: null }, 'missing_field'],
    [{ volume: undefined }, 'missing_field'],
    [{ open: Number.NaN }, 'non_finite'],
    [{ low: 0 }, 'non_positive_price'],
    [{ volume: -1 }, 'negative_volume'],
    [{ low: 106 }, 'inconsistent_range'],
    [{ close: 120 }, 'inconsistent_range'],
  ])('rejects %j as %s, never coercing to zero', (patch, reason) => {
    const r = validateBar({ ...bar, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe(reason);
  });

  it('keeps the bar but drops a bad adjusted close', () => {
    const r = validateBar({ ...bar, adjClose: null });
    expect(r.ok && r.value.adjClose).toBeNull();
  });
});

describe('sessions and freshness', () => {
  it('converts epoch seconds to the IST trading date', () => {
    // 2026-10-30 03:45 UTC = 09:15 IST, market open
    expect(istDateFromEpochSeconds(Date.UTC(2026, 9, 30, 3, 45) / 1000)).toBe('2026-10-30');
    // 2026-10-30 20:00 UTC = 01:30 IST next day
    expect(istDateFromEpochSeconds(Date.UTC(2026, 9, 30, 20, 0) / 1000)).toBe('2026-10-31');
  });

  it('treats today’s bar as incomplete before the session settles', () => {
    expect(isCompletedSession('2026-10-30', new Date('2026-10-30T08:00:00Z'))).toBe(false); // 13:30 IST
    expect(isCompletedSession('2026-10-30', new Date('2026-10-30T11:00:00Z'))).toBe(true); // 16:30 IST
    expect(isCompletedSession('2026-10-29', new Date('2026-10-30T04:00:00Z'))).toBe(true);
  });

  it('finds the latest expected session across weekends and supplied holidays', () => {
    // Sunday 1 Nov 2026 → Friday 30 Oct
    expect(expectedLatestSession(new Date('2026-11-01T06:00:00Z'))).toBe('2026-10-30');
    // Monday 2 Nov before close → Friday 30 Oct
    expect(expectedLatestSession(new Date('2026-11-02T06:00:00Z'))).toBe('2026-10-30');
    // Monday after settle, with Monday a holiday → Friday
    expect(expectedLatestSession(new Date('2026-11-02T12:00:00Z'), new Set(['2026-11-02']))).toBe('2026-10-30');
  });

  it('distinguishes delayed EOD, cached, stale and unavailable', () => {
    const now = new Date('2026-11-01T06:00:00Z');
    expect(marketDataStatus({ latestTradeDate: null, lastAttemptOk: null, now })).toBe('unavailable');
    expect(marketDataStatus({ latestTradeDate: '2026-10-29', lastAttemptOk: true, now })).toBe('stale');
    expect(marketDataStatus({ latestTradeDate: '2026-10-30', lastAttemptOk: true, now })).toBe('eod_delayed');
    expect(marketDataStatus({ latestTradeDate: '2026-10-30', lastAttemptOk: false, now })).toBe('cached');
  });
});
