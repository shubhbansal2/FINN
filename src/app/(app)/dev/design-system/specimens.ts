/**
 * Specimen content for the design-system page. These are illustrative values
 * for a fictional company, chosen so every figure on the page is internally
 * consistent (deltas are computed from the values shown). They are not market
 * data and must never be imported outside src/app/(app)/dev.
 */
import type { ComparisonRow } from '@/ui/ComparisonTable';
import type { DeltaValue } from '@/ui/Delta';
import type { Evidence } from '@/ui/evidence';

export const SPECIMEN_COMPANY = { name: 'Specimen Industries', symbol: 'SPECIMEN' } as const;
export const SPECIMEN_PEER = { name: 'Example Cables', symbol: 'EXAMPLE' } as const;

/** Fixed reference instant so relative times render identically on server and client. */
export const SPECIMEN_NOW = '2026-11-01T09:30:00.000Z';

const CRORE = 1e7;

function change(current: number, base: number): DeltaValue {
  return base > 0 ? { kind: 'ratio', value: (current - base) / base } : { kind: 'not_meaningful' };
}

type Line = { id: string; label: string; current: number; previous: number; yearAgo: number; note?: string; derived?: boolean };

// ₹ crore. EBITDA = PBT + finance costs + D&A, matching the passage below (176 + 18 + 54 = 248).
const revenue: Line = { id: 'revenue', label: 'Revenue from operations', current: 1240, previous: 1180, yearAgo: 1050 };
const ebitda: Line = { id: 'ebitda', label: 'EBITDA', current: 248, previous: 230, yearAgo: 199, note: 'PBT + finance costs + D&A', derived: true };
const pbt: Line = { id: 'pbt', label: 'Profit before tax', current: 176, previous: 165, yearAgo: 150 };
const pat: Line = { id: 'pat', label: 'Profit after tax', current: 131, previous: 124, yearAgo: 112 };
const LINES: Line[] = [revenue, ebitda, pbt, pat];

export const RESULTS_EVIDENCE: Evidence = {
  documentTitle: 'Unaudited financial results, quarter ended 30 Sep 2026 (specimen)',
  documentKind: 'Results filing',
  fiscalLabel: 'Q2 FY27',
  filedAtIso: '2026-10-30T12:05:00.000Z',
  page: 3,
  passageText:
    'Statement of consolidated unaudited financial results for the quarter ended 30 September 2026.\n\n' +
    'Revenue from operations 1,240.0 | 1,180.0 | 1,050.0\nOther income 12.4 | 10.9 | 9.8\n' +
    'Finance costs 18.0 | 17.5 | 16.0\nDepreciation and amortisation expense 54.0 | 47.5 | 33.0\n' +
    'Profit before tax 176.0 | 165.0 | 150.0\nProfit for the period 131.0 | 124.0 | 112.0\n\n' +
    '(₹ in crore. Specimen text for the design system; not a real filing.)',
  quote: 'Profit before tax 176.0 | 165.0 | 150.0',
  extractionMethod: 'Table extraction (specimen)',
  verification: 'verified',
  dataMode: 'demo',
};

export const GUIDANCE_EVIDENCE: Evidence = {
  documentTitle: 'Q1 FY27 earnings call transcript (specimen)',
  documentKind: 'Concall transcript',
  fiscalLabel: 'Q1 FY27',
  filedAtIso: '2026-08-14T10:00:00.000Z',
  page: 7,
  passageText:
    'Moderator: Thank you. The next question is on margins.\n\nChief Financial Officer: For the full year we continue to ' +
    'expect EBITDA margins in the range of 19 to 20 percent, with the second half stronger as the new line ramps up. ' +
    '(Specimen text for the design system; not a real transcript.)',
  quote: 'we continue to expect EBITDA margins in the range of 19 to 20 percent',
  extractionMethod: 'Guidance extraction (specimen)',
  verification: 'verified',
  dataMode: 'demo',
};

export const UNVERIFIED_EVIDENCE: Evidence = {
  ...GUIDANCE_EVIDENCE,
  quote: 'margins will expand by 300 basis points',
  verification: 'unverified',
};

export const RESULTS_ROWS: ComparisonRow[] = LINES.map((line) => ({
  id: line.id,
  label: line.label,
  note: line.note,
  emphasis: line.id === 'pat',
  cells: [
    { kind: 'value', value: { kind: 'currency', valueInr: line.current * CRORE }, derived: line.derived },
    { kind: 'value', value: { kind: 'currency', valueInr: line.previous * CRORE }, derived: line.derived },
    { kind: 'value', value: { kind: 'currency', valueInr: line.yearAgo * CRORE }, derived: line.derived },
    { kind: 'delta', delta: change(line.current, line.previous) },
    { kind: 'delta', delta: change(line.current, line.yearAgo) },
  ],
}));

export const HEADLINE = {
  revenue: {
    valueInr: revenue.current * CRORE,
    qoq: change(revenue.current, revenue.previous),
    yoy: change(revenue.current, revenue.yearAgo),
  },
  ebitdaMargin: { ratio: ebitda.current / revenue.current },
  pat: { valueInr: pat.current * CRORE, qoq: change(pat.current, pat.previous), yoy: change(pat.current, pat.yearAgo) },
};
