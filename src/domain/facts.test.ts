import { describe, expect, it } from 'vitest';

import {
  checkComparable,
  FinancialFactSchema,
  growth,
  parseReportedNumber,
  parseUnitScale,
  periodEnding,
  previousQuarter,
  reportedCurrencyFact,
  resolveFact,
  samePeriodLastYear,
  toBaseUnits,
  type FinancialFact,
  type Period,
  type StatementBasis,
} from './facts';

function period(type: Period['type'], end: string): Period {
  const r = periodEnding(type, end);
  if (!r.ok) throw new Error(`bad test period ${end}`);
  return r.value;
}

const Q2 = period('quarter', '2026-09-30');
const Q1 = period('quarter', '2026-06-30');
const Q2LY = period('quarter', '2025-09-30');

function fact(over: { printed?: string; period?: Period; basis?: StatementBasis; doc?: string; restated?: boolean; metric?: string } = {}): FinancialFact {
  return reportedCurrencyFact({
    companyId: 'nse:specimen',
    metric: over.metric ?? 'revenue_from_operations',
    basis: over.basis ?? 'consolidated',
    period: over.period ?? Q2,
    printed: over.printed ?? '1,240.00',
    scale: 'crore',
    sourceDocumentId: over.doc ?? 'doc-1',
    sourceLocation: { page: 3, rowLabel: 'Revenue from operations' },
    extractionMethod: 'rule_parser',
    extractorVersion: 'test',
    verificationStatus: 'unverified',
    restated: over.restated,
    ingestedAt: '2026-11-01T09:00:00.000Z',
  });
}

describe('units', () => {
  it('converts crore and lakh to rupees and keeps the printed value', () => {
    const f = fact({ printed: '1,240.50' });
    expect(f.value).toBe(12_405_000_000);
    expect(f.reportedValue).toBe(1240.5);
    expect(f.reportedText).toBe('1,240.50');
    expect(f.reportedScale).toBe('crore');
    expect(toBaseUnits(12.5, 'lakh')).toBe(1_250_000);
  });

  it('reads the scale from table headers', () => {
    expect(parseUnitScale('(₹ in Crore)')).toBe('crore');
    expect(parseUnitScale('Rs. in Lakhs')).toBe('lakh');
    expect(parseUnitScale('(₹ million)')).toBe('million');
    expect(parseUnitScale('Particulars')).toBeNull();
  });

  it('parses Indian-format numbers, brackets as negatives, dashes as blank', () => {
    expect(parseReportedNumber('2,35,481.00')).toEqual({ kind: 'number', value: 235481 });
    expect(parseReportedNumber('(1,204.5)')).toEqual({ kind: 'number', value: -1204.5 });
    expect(parseReportedNumber('− 12')).toEqual({ kind: 'number', value: -12 });
    expect(parseReportedNumber('—')).toEqual({ kind: 'blank' });
    expect(parseReportedNumber('')).toEqual({ kind: 'blank' });
    expect(parseReportedNumber('12.3.4')).toEqual({ kind: 'unparseable', raw: '12.3.4' });
  });
});

describe('missing values', () => {
  it('records a blank cell as not_reported with no value, never zero', () => {
    const f = fact({ printed: '-' });
    expect(f.status).toBe('not_reported');
    expect(f.value).toBeNull();
  });

  it('records garbage as unparseable and keeps the raw text', () => {
    const f = fact({ printed: 'see note 4' });
    expect(f).toMatchObject({ status: 'unparseable', value: null, reportedText: 'see note 4' });
  });

  it('rejects a missing status carrying a value, and a reported status without one', () => {
    const base = fact();
    expect(FinancialFactSchema.safeParse({ ...base, status: 'not_reported' }).success).toBe(false);
    expect(FinancialFactSchema.safeParse({ ...base, value: null }).success).toBe(false);
  });

  it('rejects a normalized value inconsistent with the printed value and scale', () => {
    const base = fact();
    expect(FinancialFactSchema.safeParse({ ...base, value: 1240 }).success).toBe(false);
  });

  it('requires a page or section for the source location', () => {
    expect(FinancialFactSchema.safeParse({ ...fact(), sourceLocation: {} }).success).toBe(false);
  });
});

describe('periods', () => {
  it('builds Indian fiscal periods from their end dates', () => {
    expect(Q2).toEqual({ type: 'quarter', start: '2026-07-01', end: '2026-09-30', label: 'Q2 FY27' });
    expect(period('quarter', '2027-03-31').label).toBe('Q4 FY27');
    expect(period('financial_year', '2026-03-31')).toMatchObject({ start: '2025-04-01', label: 'FY26' });
    expect(period('half_year', '2026-09-30')).toMatchObject({ start: '2026-04-01', label: 'H1 FY27' });
  });

  it('rejects non-standard period ends instead of guessing', () => {
    expect(periodEnding('quarter', '2026-09-29').ok).toBe(false);
    expect(periodEnding('quarter', '2026-08-31').ok).toBe(false);
    expect(periodEnding('financial_year', '2026-12-31').ok).toBe(false);
    expect(periodEnding('half_year', '2026-12-31').ok).toBe(false);
  });

  it('finds QoQ and YoY comparison periods', () => {
    expect(previousQuarter(Q2)?.label).toBe('Q1 FY27');
    expect(previousQuarter(period('quarter', '2026-06-30'))?.label).toBe('Q4 FY26');
    expect(samePeriodLastYear(Q2)?.label).toBe('Q2 FY26');
    expect(previousQuarter(period('financial_year', '2026-03-31'))).toBeNull();
  });
});

describe('comparisons', () => {
  it('computes QoQ and YoY growth from comparable facts', () => {
    const q2 = fact({ printed: '1,240' });
    const g = growth(q2, fact({ printed: '1,180', period: Q1 }), 'qoq');
    expect(g.kind).toBe('ratio');
    if (g.kind === 'ratio') expect(g.value).toBeCloseTo(60 / 1180, 10);
    expect(growth(q2, fact({ printed: '1,050', period: Q2LY }), 'yoy').kind).toBe('ratio');
  });

  it('refuses to compare consolidated with standalone', () => {
    const g = growth(fact(), fact({ period: Q1, basis: 'standalone' }), 'qoq');
    expect(g).toEqual({ kind: 'not_computable', reason: 'basis_mismatch' });
    expect(checkComparable(fact(), fact({ basis: 'standalone' }))).toEqual({ ok: false, error: 'basis_mismatch' });
  });

  it('refuses incompatible periods: wrong prior period or different period type', () => {
    expect(growth(fact(), fact({ period: Q2LY }), 'qoq')).toEqual({ kind: 'not_computable', reason: 'not_prior_period' });
    const h1 = fact({ period: period('half_year', '2026-09-30') });
    expect(checkComparable(fact(), h1)).toEqual({ ok: false, error: 'period_type_mismatch' });
  });

  it('does not compute growth from a missing value or a non-positive base', () => {
    expect(growth(fact(), fact({ period: Q1, printed: '—' }), 'qoq')).toEqual({ kind: 'not_computable', reason: 'missing_value' });
    expect(growth(fact(), fact({ period: Q1, printed: '(5)' }), 'qoq')).toEqual({ kind: 'not_meaningful', reason: 'non_positive_base' });
  });
});

describe('resolveFact', () => {
  it('accepts agreeing sources and keeps the others as alternatives', () => {
    const r = resolveFact([fact({ doc: 'a', printed: '1,240.00' }), fact({ doc: 'b', printed: '1,240' })]);
    expect(r.kind).toBe('value');
    if (r.kind === 'value') expect(r.alternatives).toHaveLength(1);
  });

  it('flags conflicting reported figures instead of picking one', () => {
    const r = resolveFact([fact({ doc: 'a', printed: '1,240' }), fact({ doc: 'b', printed: '1,310' })]);
    expect(r.kind).toBe('conflict');
  });

  it('lets a restated figure supersede the original', () => {
    const r = resolveFact([fact({ doc: 'a', printed: '1,240' }), fact({ doc: 'b', printed: '1,262', restated: true })]);
    expect(r.kind === 'value' && r.fact.sourceDocumentId).toBe('b');
  });

  it('reports all-missing sources as missing, not zero', () => {
    expect(resolveFact([fact({ printed: '-' })]).kind).toBe('missing');
    expect(resolveFact([]).kind).toBe('none');
  });

  it('throws when asked to merge consolidated and standalone', () => {
    expect(() => resolveFact([fact(), fact({ basis: 'standalone' })])).toThrow(/different keys/);
  });
});
