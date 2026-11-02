import { describe, expect, it } from 'vitest';

import {
  directionOf,
  formatAge,
  formatDateIst,
  formatDateTimeIst,
  formatInr,
  formatMultiple,
  formatNumber,
  formatPercent,
  formatSignedPercent,
  MINUS,
} from './format';

describe('formatInr', () => {
  it('uses Indian grouping and crore suffix by default', () => {
    expect(formatInr(2_354_810_000_000)).toBe('₹2,35,481 Cr');
  });

  it('formats lakh and rupee scales', () => {
    expect(formatInr(12_50_000, { scale: 'lakh', fractionDigits: 1 })).toBe('₹12.5 L');
    expect(formatInr(1234.5, { scale: 'one' })).toBe('₹1,234.50');
  });

  it('uses a true minus sign for losses', () => {
    expect(formatInr(-45 * 1e7)).toBe(`${MINUS}₹45 Cr`);
  });

  it('does not print a negative zero after rounding', () => {
    expect(formatInr(-1_000_000)).toBe('₹0 Cr');
  });
});

describe('formatNumber', () => {
  it('groups in lakhs and crores', () => {
    expect(formatNumber(12345678)).toBe('1,23,45,678');
    expect(formatNumber(-1234.56, 1)).toBe(`${MINUS}1,234.6`);
  });
});

describe('percent formatting', () => {
  it('signs changes explicitly', () => {
    expect(formatSignedPercent(0.0421)).toBe('+4.2%');
    expect(formatSignedPercent(-0.1)).toBe(`${MINUS}10.0%`);
  });

  it('shows zero without a sign, including values that round to zero', () => {
    expect(formatSignedPercent(0)).toBe('0.0%');
    expect(formatSignedPercent(-0.0004)).toBe('0.0%');
  });

  it('formats margins unsigned', () => {
    expect(formatPercent(0.183)).toBe('18.3%');
    expect(formatPercent(-0.05)).toBe(`${MINUS}5.0%`);
  });

  it('formats multiples', () => {
    expect(formatMultiple(3.14)).toBe('3.1×');
  });
});

describe('directionOf', () => {
  it('follows the displayed precision', () => {
    expect(directionOf(0.0004)).toBe('flat');
    expect(directionOf(0.0006)).toBe('up');
    expect(directionOf(-0.02)).toBe('down');
  });
});

describe('IST date formatting', () => {
  it('converts UTC to IST and labels it', () => {
    expect(formatDateTimeIst('2026-10-30T12:05:00.000Z')).toBe('30 Oct 2026, 17:35 IST');
  });

  it('rolls the date over at IST midnight', () => {
    expect(formatDateIst('2026-10-31T19:00:00.000Z')).toBe('01 Nov 2026');
  });

  it('uses fixed month abbreviations', () => {
    expect(formatDateIst('2026-09-15T06:00:00.000Z')).toBe('15 Sep 2026');
  });

  it('rejects invalid timestamps rather than printing "Invalid Date"', () => {
    expect(() => formatDateTimeIst('not a date')).toThrow(RangeError);
  });
});

describe('formatAge', () => {
  const now = '2026-11-01T09:30:00.000Z';
  it('describes elapsed time against an explicit reference', () => {
    expect(formatAge('2026-11-01T09:29:30.000Z', now)).toBe('just now');
    expect(formatAge('2026-11-01T09:05:00.000Z', now)).toBe('25 min ago');
    expect(formatAge('2026-11-01T04:30:00.000Z', now)).toBe('5 h ago');
    expect(formatAge('2026-10-29T09:30:00.000Z', now)).toBe('3 d ago');
  });

  it('flags future timestamps instead of showing negative ages', () => {
    expect(formatAge('2026-11-02T00:00:00.000Z', now)).toBe('in the future');
  });
});
