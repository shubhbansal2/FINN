// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseReportedNumber, periodEnding, reportedCurrencyFact, toBaseUnits, type Period, type StatementBasis, type UnitScale } from '@/domain/facts';

import { FactsView } from './facts-view';
import { quarterBeforeMonth } from './engine';
import { evaluateStatement } from './scorecard';

/**
 * Financial-correctness audit. Every expected value below was worked out by
 * hand (shown in the comment beside it) and written as a literal, so these
 * tests do not re-run the implementation's own formulas.
 */

const T0 = '2026-11-01T00:00:00.000Z';
const P = (type: Period['type'], end: string) => {
  const r = periodEnding(type, end);
  if (!r.ok) throw new Error(`bad period ${end}`);
  return r.value;
};

function f(metric: string, printed: string, period: Period, opts: { basis?: StatementBasis; scale?: UnitScale } = {}) {
  return reportedCurrencyFact({
    companyId: 'nse:audit',
    metric,
    basis: opts.basis ?? 'consolidated',
    period,
    printed,
    scale: opts.scale ?? 'crore',
    sourceDocumentId: `doc-${period.end}`,
    sourceLocation: { page: 3, rowLabel: metric },
    extractionMethod: 'rule_parser',
    extractorVersion: 'audit',
    verificationStatus: 'checks_passed',
    ingestedAt: T0,
  });
}

const value = (c: { kind: string; value?: number }) => (c.kind === 'value' ? c.value : undefined);

describe('reporting periods (Indian FY: April–March)', () => {
  it('labels and bounds quarters, halves, nine months and years', () => {
    expect(P('quarter', '2026-09-30')).toMatchObject({ start: '2026-07-01', label: 'Q2 FY27' });
    expect(P('quarter', '2026-06-30')).toMatchObject({ start: '2026-04-01', label: 'Q1 FY27' });
    expect(P('quarter', '2027-03-31')).toMatchObject({ start: '2027-01-01', label: 'Q4 FY27' });
    expect(P('half_year', '2026-09-30')).toMatchObject({ start: '2026-04-01', label: 'H1 FY27' });
    expect(P('nine_months', '2026-12-31')).toMatchObject({ start: '2026-04-01' });
    expect(P('financial_year', '2026-03-31')).toMatchObject({ start: '2025-04-01', label: 'FY26' });
  });

  it('rejects period ends that are not quarter ends', () => {
    expect(periodEnding('quarter', '2026-08-31').ok).toBe(false);
    expect(periodEnding('financial_year', '2026-12-31').ok).toBe(false);
  });
});

describe('unit conversion', () => {
  it('converts every stated scale to rupees', () => {
    expect(toBaseUnits(1240, 'crore')).toBe(12_400_000_000); // 1,240 × 10^7
    expect(toBaseUnits(12.5, 'lakh')).toBe(1_250_000); // 12.5 × 10^5
    expect(toBaseUnits(2.5, 'million')).toBe(2_500_000);
    expect(toBaseUnits(1.2, 'billion')).toBe(1_200_000_000);
    expect(toBaseUnits(5, 'thousand')).toBe(5_000);
  });

  it('reads printed negatives (brackets and minus signs) and keeps the printed text', () => {
    expect(parseReportedNumber('(1,234.5)')).toEqual({ kind: 'number', value: -1234.5 });
    expect(parseReportedNumber('−18')).toEqual({ kind: 'number', value: -18 });
    expect(parseReportedNumber('-')).toEqual({ kind: 'blank' });
    const loss = f('profit_after_tax', '(1,234.5)', P('quarter', '2026-09-30'), { scale: 'lakh' });
    expect(loss.value).toBe(-123_450_000); // −1,234.5 × 10^5
    expect(loss.reportedText).toBe('(1,234.5)');
  });
});

describe('growth', () => {
  const q1 = P('quarter', '2026-06-30');
  const q2 = P('quarter', '2026-09-30');

  it('QoQ against the immediately preceding quarter', () => {
    const v = new FactsView([f('revenue_from_operations', '1,180', q1), f('revenue_from_operations', '1,240', q2)]);
    // (1,240 − 1,180) ÷ 1,180 = 60 ÷ 1,180 = 0.050847457627…
    expect(value(v.qoq('consolidated', 'revenue_from_operations', q2.end))).toBeCloseTo(0.0508474576, 9);
  });

  it('QoQ across the financial-year boundary (Q4 vs Q3)', () => {
    const v = new FactsView([f('revenue_from_operations', '1,000', P('quarter', '2025-12-31')), f('revenue_from_operations', '1,100', P('quarter', '2026-03-31'))]);
    expect(value(v.qoq('consolidated', 'revenue_from_operations', '2026-03-31'))).toBeCloseTo(0.1, 12); // 100 ÷ 1,000
  });

  it('QoQ says which period is missing instead of comparing with something else', () => {
    const v = new FactsView([f('revenue_from_operations', '1,240', q2), f('revenue_from_operations', '1,000', P('quarter', '2025-09-30'))]);
    expect(v.qoq('consolidated', 'revenue_from_operations', q2.end)).toMatchObject({ kind: 'not_computable', reason: expect.stringMatching(/previous quarter/) });
  });

  it('YoY for full years and half years compares like with like', () => {
    const fy = new FactsView([f('revenue_from_operations', '4,000', P('financial_year', '2025-03-31')), f('revenue_from_operations', '4,800', P('financial_year', '2026-03-31'))]);
    expect(value(fy.yoy('consolidated', 'revenue_from_operations', 'financial_year', '2026-03-31'))).toBeCloseTo(0.2, 12); // 800 ÷ 4,000
    const h1 = new FactsView([f('revenue_from_operations', '2,300', P('half_year', '2025-09-30')), f('revenue_from_operations', '2,420', P('half_year', '2026-09-30')), f('revenue_from_operations', '1,000', P('quarter', '2025-09-30'))]);
    expect(value(h1.yoy('consolidated', 'revenue_from_operations', 'half_year', '2026-09-30'))).toBeCloseTo(0.0521739130, 9); // 120 ÷ 2,300
  });

  it('growth from a negative or zero base is not computed; growth into a loss is', () => {
    const negBase = new FactsView([f('profit_after_tax', '(40)', P('quarter', '2025-09-30')), f('profit_after_tax', '25', q2)]);
    expect(negBase.yoy('consolidated', 'profit_after_tax', 'quarter', q2.end).kind).toBe('not_computable');
    const zeroBase = new FactsView([f('profit_after_tax', '0', q1), f('profit_after_tax', '25', q2)]);
    expect(zeroBase.qoq('consolidated', 'profit_after_tax', q2.end).kind).toBe('not_computable');
    const intoLoss = new FactsView([f('profit_after_tax', '30', q1), f('profit_after_tax', '(15)', q2)]);
    expect(value(intoLoss.qoq('consolidated', 'profit_after_tax', q2.end))).toBeCloseTo(-1.5, 12); // (−15 − 30) ÷ 30
  });
});

describe('EBITDA and margins', () => {
  const q2 = P('quarter', '2026-09-30');

  it('EBITDA with a pre-tax loss, and its margin', () => {
    const v = new FactsView([f('revenue_from_operations', '500', q2), f('pbt', '(20)', q2), f('finance_costs', '30', q2), f('depreciation_amortisation', '40', q2)]);
    expect(value(v.ebitda('consolidated', 'quarter', q2.end))).toBe(500_000_000); // (−20 + 30 + 40) = 50 Cr
    expect(value(v.margin('consolidated', 'ebitda', 'quarter', q2.end))).toBeCloseTo(0.1, 12); // 50 ÷ 500
  });

  it('a loss gives a negative PAT margin; zero revenue gives none', () => {
    const v = new FactsView([f('revenue_from_operations', '1,240', q2), f('profit_after_tax', '(50)', q2)]);
    expect(value(v.margin('consolidated', 'profit_after_tax', 'quarter', q2.end))).toBeCloseTo(-0.0403225806, 9); // −50 ÷ 1,240
    const zero = new FactsView([f('revenue_from_operations', '0', q2), f('profit_after_tax', '5', q2)]);
    expect(zero.margin('consolidated', 'profit_after_tax', 'quarter', q2.end)).toMatchObject({ kind: 'not_computable', reason: expect.stringMatching(/not positive/) });
  });

  it('never divides a standalone figure by consolidated revenue', () => {
    const v = new FactsView([f('revenue_from_operations', '1,240', q2), f('profit_after_tax', '131', q2, { basis: 'standalone' })]);
    expect(v.margin('consolidated', 'profit_after_tax', 'quarter', q2.end).kind).toBe('not_computable');
    expect(v.margin('standalone', 'profit_after_tax', 'quarter', q2.end).kind).toBe('not_computable');
  });
});

describe('guidance scorecard arithmetic', () => {
  const q2ly = P('quarter', '2025-09-30');
  const q2 = P('quarter', '2026-09-30');
  const growth = (current: string) => new FactsView([f('revenue_from_operations', '1,000', q2ly), f('revenue_from_operations', current, q2)]);
  const statement = (low: number, high: number) =>
    ({ nature: 'quantitative', subject: 'revenue_growth', targetLow: low, targetHigh: high, targetUnit: 'percent', horizonText: 'Q2 FY27', horizonPeriod: 'Q2 FY27', quote: 'q' }) as const;

  it('an actual exactly on the lower bound is within the range despite floating point', () => {
    // 1,290 vs 1,000 = 29.0% growth; 0.29 × 100 is 28.999999999999996 in floating point.
    expect(evaluateStatement(statement(29, 31), growth('1,290'))).toMatchObject({ verdict: 'met', variancePp: 0 });
  });

  it('below and above a range, with variance from the nearer bound', () => {
    expect(evaluateStatement(statement(29, 31), growth('1,280'))).toMatchObject({ verdict: 'missed', variancePp: -1 }); // 28.0 − 29
    expect(evaluateStatement(statement(29, 31), growth('1,325'))).toMatchObject({ verdict: 'exceeded', variancePp: 1.5 }); // 32.5 − 31
  });

  it('point targets allow ±0.25 pp', () => {
    expect(evaluateStatement(statement(20, 20), growth('1,202'))).toMatchObject({ verdict: 'met', variancePp: 0.2 }); // 20.2 − 20
    expect(evaluateStatement(statement(20, 20), growth('1,203'))).toMatchObject({ verdict: 'exceeded', variancePp: 0.3 }); // 20.3 − 20
  });

  it('a horizon later than the latest reported quarter is awaiting results', () => {
    expect(evaluateStatement({ ...statement(10, 12), horizonPeriod: 'FY27', horizonText: 'FY27' }, growth('1,100'))).toMatchObject({ verdict: 'awaiting_results' });
  });
});

describe('which quarter a call discusses', () => {
  it('is the latest quarter ended before the call month, across the year boundary', () => {
    expect(quarterBeforeMonth('Jul 2026')).toBe('Q1 FY27'); // Apr–Jun 2026
    expect(quarterBeforeMonth('Oct 2025')).toBe('Q2 FY26'); // Jul–Sep 2025
    expect(quarterBeforeMonth('Jan 2026')).toBe('Q3 FY26'); // Oct–Dec 2025
    expect(quarterBeforeMonth('May 2026')).toBe('Q4 FY26'); // Jan–Mar 2026
    expect(quarterBeforeMonth('Dec 2025')).toBe('Q2 FY26'); // Jul–Sep 2025
  });

  it('returns nothing for labels that are not a month and year', () => {
    expect(quarterBeforeMonth('Earnings call transcript')).toBeNull();
    expect(quarterBeforeMonth(null)).toBeNull();
  });
});
