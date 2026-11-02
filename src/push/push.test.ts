// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { seededDb, T0 } from '@/test/helpers';

import { dailyReturn, evaluatePriceMove, evaluateVolumeSpike, volumeRatio } from './anomalies';
import { buildDigest, combineSignals, compareSignals, parseWindow, sessionDistance, sessionOf } from './digest';
import { loadPolicy, parsePolicy, PolicyError, rankAnnouncement, type SignalPolicy } from './policy';
import { evaluateRules, RuleInputSchema, type AlertRule } from './rules';
import { evaluateAlerts, getDigest } from './service';
import { acknowledgeAlerts, listAlerts, listRules, recordAlerts, saveRule } from './store';
import type { AnnouncementInputRow, BarSeries, Signal } from './types';

const policy: SignalPolicy = loadPolicy();
const NOW = new Date('2026-10-30T18:00:00Z'); // Friday 23:30 IST

// ------------------------------------------------------------------ builders

/** Weekday trading dates ending on `last`, oldest first. */
function tradingDates(count: number, last = '2026-10-30'): string[] {
  const out: string[] = [];
  for (let d = new Date(`${last}T00:00:00Z`); out.length < count; d = new Date(d.getTime() - 86_400_000)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

function series(closes: number[], volumes?: number[], opts: { last?: string; adj?: (number | null)[]; companyId?: string } = {}): BarSeries {
  const dates = tradingDates(closes.length, opts.last);
  return {
    companyId: opts.companyId ?? 'nse:specimen',
    companyName: 'Specimen Industries',
    symbol: 'SPECIMEN',
    listingId: `NSE:${(opts.companyId ?? 'nse:specimen').slice(4).toUpperCase()}`,
    bars: closes.map((c, i) => ({
      tradeDate: dates[i] as string,
      open: c,
      high: c * 1.01,
      low: c * 0.99,
      close: c,
      adjClose: opts.adj ? (opts.adj[i] ?? null) : c,
      volume: volumes?.[i] ?? 1000,
      lastIngestedAt: '2026-10-30T12:00:00.000Z',
    })),
    dataMode: 'fixture',
  };
}

const flat = (n: number, v = 100) => Array.from({ length: n }, () => v);

function announcement(over: Partial<AnnouncementInputRow> = {}): AnnouncementInputRow {
  return {
    id: 'a1',
    documentId: 'd1',
    companyId: 'nse:specimen',
    companyName: 'Specimen Industries',
    symbol: 'SPECIMEN',
    title: 'Unaudited Financial Results for the quarter ended September 30, 2026',
    publishedAt: '2026-10-30T14:12:00.000Z',
    ingestedAt: '2026-10-30T15:00:00.000Z',
    category: 'results',
    classificationStatus: 'matched',
    secondary: [],
    documentUrl: 'https://www.bseindia.com/a1.pdf',
    documentOrigin: 'exchange_filed',
    duplicateOfDocument: null,
    attachmentText: null,
    figures: [],
    dataMode: 'fixture',
    ...over,
  };
}

const lastIndex = (s: BarSeries) => s.bars.length - 1;

// ------------------------------------------------------------------ policy

describe('signal policy', () => {
  it('loads the committed policy and rejects invalid ones', () => {
    expect(policy.categoryTiers.results).toBe('high');
    expect(() => parsePolicy({ ...policy, categoryTiers: { results: 'high' } })).toThrow(PolicyError);
    expect(() => parsePolicy({ ...policy, contentRules: [{ id: 'x.bad', category: 'results', pattern: '(unclosed', tier: 'low', reason: 'broken regex' }] })).toThrow(/invalid pattern/);
  });
});

// ------------------------------------------------------------------ announcements

describe('announcement ranking', () => {
  it('ranks results outcomes high and results notices low, by content', () => {
    const out = rankAnnouncement(announcement(), policy, NOW);
    expect(out).toMatchObject({ tier: 'high', kind: 'results' });
    const notice = rankAnnouncement(announcement({ title: 'Board Meeting Intimation for considering Financial Results' }), policy, NOW);
    expect(notice).toMatchObject({ tier: 'low', kind: 'announcement' });
    expect(notice.explanation.rules).toContain('content:results.intimation');
  });

  it('does not treat every filing in a material category as important', () => {
    const cfo = rankAnnouncement(announcement({ category: 'management_change', title: 'Resignation of Chief Financial Officer' }), policy, NOW);
    const cs = rankAnnouncement(announcement({ category: 'management_change', title: 'Appointment of Company Secretary and Compliance Officer' }), policy, NOW);
    const cp = rankAnnouncement(announcement({ category: 'fund_raise', title: 'Allotment of Commercial Paper' }), policy, NOW);
    expect([cfo.tier, cs.tier, cp.tier]).toEqual(['high', 'low', 'low']);
  });

  it('uses downloaded attachment text when the subject alone is uninformative', () => {
    const r = rankAnnouncement(announcement({ category: 'credit_rating', title: 'Credit Rating', attachmentText: 'ICRA has downgraded the long-term rating' }), policy, NOW);
    expect(r).toMatchObject({ tier: 'high' });
    expect(r.explanation.unknowns.join(' ')).not.toMatch(/attachment has not been read/);
  });

  it('lowers filings without a primary-source document and says so', () => {
    const r = rankAnnouncement(announcement({ documentUrl: null, documentOrigin: null }), policy, NOW);
    expect(r.tier).toBe('medium');
    expect(r.explanation.rules).toContain('evidence:missing');
  });

  it('keeps ambiguous and routine filings low, with the reason', () => {
    expect(rankAnnouncement(announcement({ category: 'unclassified', classificationStatus: 'ambiguous', secondary: ['results', 'investor_meetings'] }), policy, NOW).explanation.why[0]).toMatch(/could be Results or Investor meetings/);
    expect(rankAnnouncement(announcement({ category: 'unclassified', classificationStatus: 'routine', title: 'Closure of Trading Window' }), policy, NOW).tier).toBe('routine');
  });

  it('marks old filings stale without changing their tier', () => {
    const r = rankAnnouncement(announcement({ publishedAt: '2026-10-20T10:00:00.000Z' }), policy, NOW);
    expect(r).toMatchObject({ tier: 'high', stale: true });
  });
});

// ------------------------------------------------------------------ price

describe('price moves', () => {
  const params = { ...policy.prices, movePct: 5 };

  it('fires at the threshold boundary and not just below it', () => {
    expect(evaluatePriceMove(series([100, 105]), 1, params).status).toBe('signal');
    expect(evaluatePriceMove(series([100, 104.99]), 1, params).status).toBe('below_threshold');
    expect(evaluatePriceMove(series([100, 95]), 1, params).status).toBe('signal');
    expect(evaluatePriceMove(series([100, 95.01]), 1, params).status).toBe('below_threshold');
  });

  it('handles positive and negative moves, direction filters and high tier', () => {
    const down = evaluatePriceMove(series([100, 89]), 1, params);
    expect(down.status === 'signal' && down.signal).toMatchObject({ tier: 'high', headline: 'SPECIMEN fell 11.0% on the day' });
    const up = evaluatePriceMove(series([100, 106]), 1, params);
    expect(up.status === 'signal' && up.signal.tier).toBe('medium');
    expect(evaluatePriceMove(series([100, 106]), 1, { ...params, direction: 'down' }).status).toBe('filtered');
  });

  it('uses the adjusted series and flags a likely corporate action', () => {
    // 1:1 bonus: raw close halves, adjusted close is flat.
    const s = series([200, 100], undefined, { adj: [100, 100] });
    expect(evaluatePriceMove(s, 1, params).status).toBe('below_threshold');
    const r = dailyReturn(s, 1, params);
    expect(r.ok && r.notes[0]).toMatch(/split, bonus or dividend adjustment is likely/);
  });

  it('falls back to raw close with a caveat when adjusted data is missing', () => {
    const r = evaluatePriceMove(series([100, 110], undefined, { adj: [null, null] }), 1, params);
    expect(r.status === 'signal' && r.signal.explanation.unknowns.join(' ')).toMatch(/raw close is used/);
  });

  it('never claims causation and refuses comparisons across data gaps', () => {
    const r = evaluatePriceMove(series([100, 110]), 1, params);
    expect(r.status === 'signal' && r.signal.explanation.unknowns).toContain('FINN has not established what caused this move.');
    const gap = series([100, 110]);
    if (gap.bars[0]) gap.bars[0].tradeDate = '2026-10-01';
    expect(evaluatePriceMove(gap, 1, params)).toMatchObject({ status: 'not_computable', reason: expect.stringMatching(/days earlier/) });
    expect(evaluatePriceMove(series([100]), 0, params).status).toBe('not_computable');
  });
});

// ------------------------------------------------------------------ volume

describe('volume spikes', () => {
  const params = policy.volume; // 2×, 20-session lookback, 15 minimum

  it('excludes the current session from its own baseline', () => {
    const s = series(flat(21), [...flat(20, 1000), 2000]);
    const r = volumeRatio(s, lastIndex(s), params);
    expect(r.ok && r.mean).toBe(1000);
    expect(r.ok && r.ratio).toBe(2);
    expect(evaluateVolumeSpike(s, lastIndex(s), params).status).toBe('signal');
    // Thresholds compare at the displayed precision (2 decimals): 1.994× shows as 1.99× and does not fire;
    // 1.999× shows as 2.00× and does, so the screen never shows a threshold value that did not alert.
    const just = series(flat(21), [...flat(20, 1000), 1994]);
    expect(evaluateVolumeSpike(just, lastIndex(just), params).status).toBe('below_threshold');
    const shownAsTwo = series(flat(21), [...flat(20, 1000), 1999]);
    expect(evaluateVolumeSpike(shownAsTwo, lastIndex(shownAsTwo), params).status).toBe('signal');
  });

  it('reports insufficient history instead of guessing', () => {
    const s = series(flat(10), [...flat(9, 1000), 9000]);
    expect(evaluateVolumeSpike(s, lastIndex(s), params)).toMatchObject({ status: 'not_computable', reason: expect.stringMatching(/insufficient history: 9 usable prior sessions, 15 required/) });
  });

  it('treats zero volume as unavailable and avoids division by zero', () => {
    const zeros = series(flat(21), [...flat(20, 0), 5000]);
    expect(evaluateVolumeSpike(zeros, lastIndex(zeros), params).status).toBe('not_computable');
    const today0 = series(flat(21), [...flat(20, 1000), 0]);
    expect(evaluateVolumeSpike(today0, lastIndex(today0), params)).toMatchObject({ status: 'not_computable', reason: expect.stringMatching(/treated as unavailable/) });
    const someZero = series(flat(21), [...flat(4, 0), ...flat(16, 1000), 3000]);
    const r = evaluateVolumeSpike(someZero, lastIndex(someZero), params);
    expect(r.status === 'signal' && r.signal.explanation.unknowns.join(' ')).toMatch(/4 zero-volume session\(s\).*excluded/);
  });

  it('applies the minimum-volume noise filter', () => {
    const s = series(flat(21), [...flat(20, 10), 50]);
    expect(evaluateVolumeSpike(s, lastIndex(s), { ...params, minVolumeShares: 100 }).status).toBe('filtered');
  });
});

// ------------------------------------------------------------------ combinations and digest

describe('combinations', () => {
  it('combines price and volume on the same session, keeping both components', () => {
    const s = series([...flat(20), 110], [...flat(20, 1000), 3000]);
    const px = evaluatePriceMove(s, lastIndex(s), policy.prices);
    const vol = evaluateVolumeSpike(s, lastIndex(s), policy.volume);
    const parts = [px, vol].map((r) => (r.status === 'signal' ? r.signal : null)).filter((x): x is Signal => !!x);
    const combos = combineSignals(parts, policy);
    expect(combos).toHaveLength(1);
    expect(combos[0]).toMatchObject({ kind: 'combination', tier: 'high', components: parts.map((p) => p.id).sort() });
    expect(combos[0]?.explanation.unknowns[0]).toMatch(/Co-occurrence is not evidence/);
  });

  it('maps filings to the session they can affect', () => {
    expect(sessionOf('2026-10-30T14:12:00Z')).toBe('2026-11-02'); // Fri 19:42 IST → Monday
    expect(sessionOf('2026-10-30T05:00:00Z')).toBe('2026-10-30'); // Fri 10:30 IST → same day
    expect(sessionDistance('2026-10-30', '2026-11-02')).toBe(1);
  });
});

describe('digest', () => {
  const window = (w = '24h') => {
    const r = parseWindow(w, NOW);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it('defaults to 24 hours, supports IST custom ranges and rejects bad input', () => {
    expect(window()).toMatchObject({ from: '2026-10-29T18:00:00.000Z', to: '2026-10-30T18:00:00.000Z' });
    // 30 Oct IST runs from 29 Oct 18:30 UTC to 30 Oct 18:30 UTC.
    expect(window('2026-10-30..2026-10-30')).toMatchObject({ from: '2026-10-29T18:30:00.000Z', to: '2026-10-30T18:30:00.000Z' });
    expect(parseWindow('2026-10-01..2026-12-31', NOW).ok).toBe(false);
    expect(parseWindow('yesterday', NOW).ok).toBe(false);
  });

  it('filters by publication time with half-open boundaries', () => {
    const at = (t: string, id: string) => announcement({ id, documentUrl: `https://www.bseindia.com/${id}.pdf`, documentId: id, title: `Results ${id}`, publishedAt: t });
    const d = buildDigest({ announcements: [at('2026-10-29T18:00:00.000Z', 'start'), at('2026-10-30T18:00:00.000Z', 'end'), at('2026-10-29T17:59:59.000Z', 'before')], series: [], policy, window: window(), now: NOW });
    const ids = d.groups.flatMap((g) => g.items.map((i) => i.signal.headline));
    expect(ids).toEqual(['Results start']);
    expect(d.latestBefore?.headline).toBe('Results before');
  });

  it('suppresses duplicate filings but keeps them listed under the original', () => {
    const d = buildDigest({
      announcements: [
        announcement(),
        announcement({ id: 'a2', documentId: 'd2', duplicateOfDocument: 'd1', documentUrl: 'https://www.bseindia.com/a2.pdf', title: 'Board Meeting Outcome for Unaudited Financial Results', publishedAt: '2026-10-30T14:08:00.000Z' }),
      ],
      series: [],
      policy,
      window: window(),
      now: NOW,
    });
    expect(d.counts.duplicatesSuppressed).toBe(1);
    expect(d.groups[0]?.items).toHaveLength(1);
    expect(d.groups[0]?.items[0]?.signal.duplicates).toHaveLength(1);
  });

  it('collapses routine filings and still renders when nothing important happened', () => {
    const d = buildDigest({ announcements: [announcement({ category: 'unclassified', classificationStatus: 'routine', title: 'Closure of Trading Window' })], series: [], policy, window: window(), now: NOW });
    expect(d.groups[0]).toMatchObject({ items: [], routine: [expect.objectContaining({ tier: 'routine' })] });
    expect(d.counts).toMatchObject({ total: 1, routineCollapsed: 1, high: 0 });
    const empty = buildDigest({ announcements: [], series: [], policy, window: window(), now: NOW });
    expect(empty).toMatchObject({ groups: [], dataMode: 'none' });
  });

  it('keeps every signal from one company and day, grouped and nested', () => {
    const s = series([...flat(20), 110], [...flat(20, 1000), 3000]);
    const d = buildDigest({ announcements: [announcement({ publishedAt: '2026-10-30T05:00:00.000Z' })], series: [s], policy, window: window(), now: NOW });
    expect(d.groups).toHaveLength(1);
    const kinds = d.groups[0]?.items.flatMap((i) => [i.signal.kind, ...i.children.map((c) => c.kind)]).sort();
    // Results + price + volume are all preserved, inside the combinations that link them.
    expect(new Set(kinds)).toEqual(new Set(['combination', 'price_move', 'volume_spike', 'results']));
    // Two combination rules sharing the price move merge into one item: the move is shown once.
    expect(d.groups[0]?.items).toHaveLength(1);
    expect(d.groups[0]?.items[0]?.children.map((c) => c.kind).sort()).toEqual(['price_move', 'results', 'volume_spike']);
    expect(d.groups[0]?.items[0]?.signal.explanation.rules).toEqual(expect.arrayContaining(['combination:price_and_volume', 'combination:filing_and_move']));
  });

  it('ranks equivalent inputs identically regardless of input order', () => {
    const rows = ['x', 'y', 'z'].map((id) => announcement({ id, documentId: id, documentUrl: `https://www.bseindia.com/${id}.pdf`, title: `Results ${id}` }));
    const a = buildDigest({ announcements: rows, series: [], policy, window: window(), now: NOW });
    const b = buildDigest({ announcements: [...rows].reverse(), series: [], policy, window: window(), now: NOW });
    expect(a.groups[0]?.items.map((i) => i.signal.id)).toEqual(b.groups[0]?.items.map((i) => i.signal.id));
    const sorted = [...(a.groups[0]?.items.map((i) => i.signal) ?? [])];
    expect(sorted.sort(compareSignals).map((s) => s.id)).toEqual(a.groups[0]?.items.map((i) => i.signal.id));
  });
});

// ------------------------------------------------------------------ alert rules

describe('alert rules', () => {
  const rule = (over: Partial<AlertRule> = {}): AlertRule =>
    ({ id: 'r1', version: 1, createdAt: T0, updatedAt: T0, kind: 'price_move', name: 'Move', enabled: true, scope: { type: 'watchlist' }, params: { thresholdPct: 5, direction: 'both', minVolumeShares: 0 }, ...over }) as AlertRule;
  const s = series([100, 100, 107]);
  const base = { series: [s], announcements: [], watchlist: new Set(['nse:specimen']), policy, since: '2026-10-01T00:00:00.000Z' };

  it('validates rule input at the boundary', () => {
    expect(RuleInputSchema.safeParse({ kind: 'price_move', name: 'x', enabled: true, scope: { type: 'watchlist' }, params: { thresholdPct: 0, direction: 'both', minVolumeShares: 0 } }).success).toBe(false);
    expect(RuleInputSchema.safeParse({ kind: 'volume_spike', name: 'x', enabled: true, scope: { type: 'watchlist' }, params: { multiple: 2, lookbackSessions: 10, minHistorySessions: 20, minVolumeShares: 0 } }).success).toBe(false);
  });

  it('respects scope and enabled flags', () => {
    expect(evaluateRules({ ...base, rules: [rule()] })).toHaveLength(1);
    expect(evaluateRules({ ...base, rules: [rule({ enabled: false })] })).toHaveLength(0);
    expect(evaluateRules({ ...base, rules: [rule({ scope: { type: 'companies', companyIds: ['nse:other'] } })] })).toHaveLength(0);
  });

  it('never notifies twice for the same event, across re-evaluation and rule edits', () => {
    const db = seededDb();
    const saved = saveRule(db, { kind: 'price_move', name: 'Move', enabled: true, scope: { type: 'watchlist' }, params: { thresholdPct: 5, direction: 'both', minVolumeShares: 0 } }, T0);
    const first = recordAlerts(db, evaluateRules({ ...base, rules: [saved] }), T0);
    const again = recordAlerts(db, evaluateRules({ ...base, rules: [saved] }), T0);
    expect([first.created.length, again.created.length, again.skipped]).toEqual([1, 0, 1]);

    // Editing the rule bumps its version but the already-alerted session stays alerted once.
    const edited = saveRule(db, { kind: 'price_move', name: 'Move 3%', enabled: true, scope: { type: 'watchlist' }, params: { thresholdPct: 3, direction: 'both', minVolumeShares: 0 } }, T0, saved.id);
    expect(edited.version).toBe(2);
    expect(recordAlerts(db, evaluateRules({ ...base, rules: [edited] }), T0).created).toHaveLength(0);
    expect(listAlerts(db)).toHaveLength(1);
  });

  it('applies changed thresholds to subsequent evaluation', () => {
    const s2 = series([100, 103, 103]);
    expect(evaluateRules({ ...base, series: [s2], rules: [rule()] })).toHaveLength(0);
    expect(evaluateRules({ ...base, series: [s2], rules: [rule({ params: { thresholdPct: 3, direction: 'both', minVolumeShares: 0 } } as Partial<AlertRule>)] })).toHaveLength(1);
  });

  it('does not re-alert a filing that arrives again under another identity', () => {
    const db = seededDb();
    const annRule = saveRule(db, { kind: 'announcement', name: 'Results', enabled: true, scope: { type: 'watchlist' }, params: { categories: ['results'], minTier: 'medium' } }, T0);
    const first = rankAnnouncement(announcement(), policy, NOW);
    recordAlerts(db, evaluateRules({ ...base, series: [], rules: [annRule], announcements: [first] }), T0);
    const relisted = rankAnnouncement(announcement({ id: 'a9' }), policy, NOW);
    relisted.duplicates.push({ id: first.id, headline: first.headline, occurredAt: first.occurredAt });
    expect(recordAlerts(db, evaluateRules({ ...base, series: [], rules: [annRule], announcements: [relisted] }), T0).created).toHaveLength(0);
  });

  it('separates delivery from evaluation: events start pending and can be acknowledged', () => {
    const db = seededDb();
    const saved = saveRule(db, { kind: 'price_move', name: 'Move', enabled: true, scope: { type: 'watchlist' }, params: { thresholdPct: 5, direction: 'both', minVolumeShares: 0 } }, T0);
    const { created } = recordAlerts(db, evaluateRules({ ...base, rules: [saved] }), T0);
    expect(listAlerts(db, { status: 'pending' })).toHaveLength(1);
    expect(acknowledgeAlerts(db, created.map((c) => c.id), T0)).toBe(1);
    expect(acknowledgeAlerts(db, created.map((c) => c.id), T0)).toBe(0);
    expect(listAlerts(db, { status: 'seen' })[0]?.delivery.seenAt).toBe(T0);
  });
});

// ------------------------------------------------------------------ service on a database

describe('service', () => {
  it('seeds default rules once and evaluates idempotently against stored data', () => {
    const db = seededDb();
    const fetchId = 'f1';
    db.prepare(`INSERT INTO source_fetch (id, provider, data_mode, request_key, started_at) VALUES (?, 'test', 'fixture', 'k', ?)`).run(fetchId, T0);
    const s = series([...flat(20), 112], [...flat(20, 1000), 4000]);
    const insert = db.prepare(`INSERT INTO price_bar (listing_id, trade_date, open, high, low, close, adj_close, volume, source_fetch_id, first_ingested_at, last_ingested_at) VALUES ('NSE:SPECIMEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const b of s.bars) insert.run(b.tradeDate, b.open, b.high, b.low, b.close, b.adjClose, b.volume, fetchId, T0, T0);

    const first = evaluateAlerts(db, { now: NOW, dataMode: 'fixture' });
    expect(listRules(db)).toHaveLength(3);
    expect(first.created.map((c) => c.signal.kind).sort()).toEqual(['price_move', 'volume_spike']);
    const second = evaluateAlerts(db, { now: NOW, dataMode: 'fixture' });
    expect(second.created).toHaveLength(0);

    const digest = getDigest(db, { window: '24h', now: NOW, dataMode: 'fixture' });
    expect(digest.ok && digest.value.groups[0]?.items[0]).toMatchObject({ alerted: true, signal: { kind: 'combination' } });
  });

  it('reports an invalid window as an error, not an empty digest', () => {
    expect(getDigest(seededDb(), { window: 'forever', now: NOW, dataMode: 'fixture' }).ok).toBe(false);
  });
});
