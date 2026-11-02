import { periodEnding, type FinancialFact, type StatementBasis } from '@/domain/facts';
import { FactsView, type DerivedCell, type FactCell } from '@/research/facts-view';

import type { Change, FirstCutLine, ResultsFirstCut } from './types';

const LINES: { metric: FirstCutLine['metric']; label: string; source: string | 'ebitda' }[] = [
  { metric: 'revenue', label: 'Revenue', source: 'revenue_from_operations' },
  { metric: 'ebitda', label: 'EBITDA', source: 'ebitda' },
  { metric: 'pbt', label: 'PBT', source: 'pbt' },
  { metric: 'pat', label: 'PAT', source: 'profit_after_tax' },
];

/** growth.v1, the same rule the research view uses: defined only for a positive base. */
export function change(current: number | null, base: number | null): Change {
  if (current === null || base === null) return { kind: 'missing' };
  if (base <= 0) return { kind: 'not_meaningful' };
  return { kind: 'ratio', value: (current - base) / base };
}

type Read = { value: number | null; reason: string | null; page: number | null };

/**
 * One figure, only if it passed the filing's own arithmetic checks. A headline
 * in the feed is a stronger claim than a flagged cell in research, so an
 * unchecked figure is left out with its reason rather than shown.
 */
function read(view: FactsView, basis: StatementBasis, source: string, end: string): Read {
  const cell: FactCell | DerivedCell = source === 'ebitda' ? view.ebitda(basis, 'quarter', end) : view.get(basis, source, 'quarter', end);
  if (cell.kind === 'value') {
    if (!cell.verified) return { value: null, reason: UNCHECKED, page: null };
    const fact = 'fact' in cell ? cell.fact : cell.inputs[0];
    return { value: cell.value, reason: null, page: fact?.sourceLocation.page ?? null };
  }
  if (cell.kind === 'conflict') return { value: null, reason: 'the filing gives conflicting figures', page: null };
  return { value: null, reason: cell.reason, page: null };
}

export const UNCHECKED = 'could not be checked against the filing’s own arithmetic';

const previousQuarterEnd = (end: string) => new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 3, 0)).toISOString().slice(0, 10);
const yearAgoEnd = (end: string) => `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`;
const labelOf = (end: string) => {
  const p = periodEnding('quarter', end);
  return p.ok ? p.value.label : end;
};

/**
 * The results first cut for one filing, from the facts parsed out of that
 * filing only. Consolidated figures are preferred (they cover the whole group);
 * standalone is used when the filing has no consolidated statement. Returns
 * null when no quarterly figures were read.
 */
export function buildFirstCut(facts: FinancialFact[], linkFor: (page: number | null) => string | null): ResultsFirstCut | null {
  const view = new FactsView(facts);
  const basis: StatementBasis = view.periods('consolidated', 'quarter').length ? 'consolidated' : 'standalone';
  const end = view.periods(basis, 'quarter')[0];
  if (!end) return null;
  const prevEnd = previousQuarterEnd(end);
  const yoyEnd = yearAgoEnd(end);

  let page: number | null = null;
  const lines = LINES.map(({ metric, label, source }): FirstCutLine => {
    const cur = read(view, basis, source, end);
    const prev = read(view, basis, source, prevEnd);
    const ago = read(view, basis, source, yoyEnd);
    page ??= cur.page;
    return {
      metric,
      label,
      current: cur.value,
      previous: prev.value,
      yearAgo: ago.value,
      qoq: change(cur.value, prev.value),
      yoy: change(cur.value, ago.value),
      derived: source === 'ebitda',
      note: cur.reason,
    };
  });

  // A quarter that yielded none of the four lines is not a first cut.
  if (lines.every((l) => l.current === null)) return null;
  return { basis, quarter: { end, label: labelOf(end) }, previousLabel: labelOf(prevEnd), yearAgoLabel: labelOf(yoyEnd), lines, page, url: linkFor(page) };
}
