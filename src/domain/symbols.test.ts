import { describe, expect, it } from 'vitest';

import { parseUniverse, UniverseConfigError } from '@/config/universe';

import { companyIdFor, normalizeBseCode, normalizeNseSymbol, toYahooSymbol } from './symbols';

describe('normalizeNseSymbol', () => {
  it.each([
    ['reliance', 'RELIANCE'],
    [' RELIANCE.NS ', 'RELIANCE'],
    ['NSE:infy', 'INFY'],
    ['M&M', 'M&M'],
    ['bajaj-auto', 'BAJAJ-AUTO'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeNseSymbol(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['RELI ANCE', 'invalid_characters'],
    ['RELIANCE;DROP', 'invalid_characters'],
    ['-RELIANCE', 'invalid_characters'],
    ['ABCDEFGHIJKLMNOPQRSTUV', 'too_long'],
    ['500325.BO', 'wrong_exchange_suffix'],
  ])('rejects %j (%s)', (input, kind) => {
    const r = normalizeNseSymbol(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe(kind);
  });
});

describe('normalizeBseCode', () => {
  it('accepts six-digit codes with or without suffix', () => {
    expect(normalizeBseCode('500325.BO')).toEqual({ ok: true, value: '500325' });
    expect(normalizeBseCode('BSE:500325')).toEqual({ ok: true, value: '500325' });
  });

  it('rejects symbols and short codes', () => {
    expect(normalizeBseCode('RELIANCE').ok).toBe(false);
    expect(normalizeBseCode('50032').ok).toBe(false);
    expect(normalizeBseCode('RELIANCE.NS').ok).toBe(false);
  });
});

describe('Yahoo mapping', () => {
  it('maps NSE symbols and BSE trading symbols, not BSE scrip codes', () => {
    expect(toYahooSymbol({ exchange: 'NSE', symbol: 'RELIANCE' })).toBe('RELIANCE.NS');
    expect(toYahooSymbol({ exchange: 'NSE', symbol: 'M&M' })).toBe('M&M.NS');
    expect(toYahooSymbol({ exchange: 'BSE', symbol: '500325', ticker: 'RELIANCE' })).toBe('RELIANCE.BO');
  });

  it('returns no mapping for a BSE listing without a known trading symbol', () => {
    expect(toYahooSymbol({ exchange: 'BSE', symbol: '500325' })).toBeNull();
  });

  it('prefers the NSE symbol for company ids, falls back to BSE', () => {
    expect(companyIdFor([{ exchange: 'BSE', symbol: '500325' }, { exchange: 'NSE', symbol: 'RELIANCE' }])).toBe('nse:reliance');
    expect(companyIdFor([{ exchange: 'BSE', symbol: '500325' }])).toBe('bse:500325');
  });
});

describe('parseUniverse', () => {
  const entry = { name: 'X', sector: 'S', size: 'mid', reportingProfile: 'industrial' };

  it('supports NSE-only and BSE-only companies', () => {
    const u = parseUniverse({ portfolio: [{ ...entry, nse: 'cdsl' }, { ...entry, name: 'Y', bseCode: '500325' }], research: [] });
    expect(u.portfolio.map((c) => c.listings)).toEqual([[{ exchange: 'NSE', symbol: 'CDSL' }], [{ exchange: 'BSE', symbol: '500325' }]]);
  });

  it('derives the BSE ticker from the NSE symbol unless overridden', () => {
    const u = parseUniverse({
      portfolio: [
        { ...entry, nse: 'RELIANCE', bseCode: '500325' },
        { ...entry, name: 'Z', nse: 'ABC', bseCode: '500001', bseTicker: 'ABCLTD' },
      ],
      research: [],
    });
    expect(u.portfolio[0]?.listings[1]).toEqual({ exchange: 'BSE', symbol: '500325', ticker: 'RELIANCE' });
    expect(u.portfolio[1]?.listings[1]).toEqual({ exchange: 'BSE', symbol: '500001', ticker: 'ABCLTD' });
    expect(() => parseUniverse({ portfolio: [{ ...entry, nse: 'X', bseCode: '500001', bseTicker: 'BAD TICKER' }], research: [] })).toThrow(/invalid BSE ticker/);
  });

  it('rejects invalid ticker mappings with the offending entry named', () => {
    expect(() => parseUniverse({ portfolio: [{ ...entry, nse: 'BAD SYMBOL' }], research: [] })).toThrow(/portfolio\[0\].*invalid NSE symbol/);
    expect(() => parseUniverse({ portfolio: [{ ...entry, bseCode: 'RELIANCE' }], research: [] })).toThrow(UniverseConfigError);
  });

  it('rejects a company with no listing and duplicates across lists', () => {
    expect(() => parseUniverse({ portfolio: [entry], research: [] })).toThrow(UniverseConfigError);
    expect(() => parseUniverse({ portfolio: [{ ...entry, nse: 'INFY' }], research: [{ ...entry, nse: 'infy.ns' }] })).toThrow(/Duplicate/);
  });

  it('loads the committed demo universe', async () => {
    const { loadUniverse } = await import('@/config/universe');
    const u = loadUniverse();
    expect(u.portfolio.length).toBeGreaterThanOrEqual(15);
    expect(u.portfolio.length).toBeLessThanOrEqual(20);
    expect(u.research.length).toBeGreaterThanOrEqual(3);
    expect(new Set(u.portfolio.map((c) => c.sector)).size).toBeGreaterThanOrEqual(10);
  });
});
