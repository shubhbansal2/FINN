import { periodEnding, type PeriodType } from '@/domain/facts';

import type { FactsView, DerivedCell } from './facts-view';
import type { StatementDraft } from './guidance';

/**
 * Guidance scorecard: management statement → subsequent reported outcome.
 * Verdicts are computed in code from extracted facts. Anything that cannot be
 * evaluated says why: qualitative, horizon not explicit, period not yet
 * reported, subject not measurable from extracted figures, or data missing.
 */

export type Verdict = 'met' | 'exceeded' | 'missed' | 'not_evaluable' | 'awaiting_results' | 'actual_unavailable';

export type ScorecardEvaluation = {
  verdict: Verdict;
  reason: string;
  actual: { value: number; unit: 'percent'; formula: string; factLabels: string[]; verified: boolean } | null;
  variancePp: number | null;
  method: string | null;
};

/** Tolerance for a point target: ±0.25 percentage points counts as met (rounding in management's own figures). */
const POINT_TOLERANCE_PP = 0.25;

function horizonToPeriod(h: string): { type: PeriodType; end: string } | null {
  const q = /^Q([1-4]) FY(\d{2})$/.exec(h);
  if (q) {
    const fy = 2000 + Number(q[2]);
    const ends = [`${fy - 1}-06-30`, `${fy - 1}-09-30`, `${fy - 1}-12-31`, `${fy}-03-31`];
    const end = ends[Number(q[1]) - 1];
    return end ? { type: 'quarter', end } : null;
  }
  const fy = /^FY(\d{2})$/.exec(h);
  if (fy) {
    const r = periodEnding('financial_year', `${2000 + Number(fy[1])}-03-31`);
    return r.ok ? { type: 'financial_year', end: r.value.end } : null;
  }
  return null;
}

function compare(actualPct: number, low: number, high: number): { verdict: Verdict; variancePp: number } {
  if (low === high) {
    const v = actualPct - low;
    if (Math.abs(v) <= POINT_TOLERANCE_PP) return { verdict: 'met', variancePp: v };
    return { verdict: v > 0 ? 'exceeded' : 'missed', variancePp: v };
  }
  if (actualPct < low) return { verdict: 'missed', variancePp: actualPct - low };
  if (actualPct > high) return { verdict: 'exceeded', variancePp: actualPct - high };
  return { verdict: 'met', variancePp: 0 };
}

export function evaluateStatement(s: Pick<StatementDraft, 'nature' | 'subject' | 'targetLow' | 'targetHigh' | 'targetUnit' | 'horizonText' | 'horizonPeriod' | 'quote'>, facts: FactsView): ScorecardEvaluation {
  const none = { actual: null, variancePp: null, method: null };
  if (s.subject === 'guidance_policy') return { verdict: 'not_evaluable', reason: 'Management stated it does not give guidance.', ...none };
  if (s.nature === 'qualitative') return { verdict: 'not_evaluable', reason: 'Qualitative commentary: no numeric target was stated, so none is inferred.', ...none };
  if (!s.horizonPeriod) {
    return { verdict: 'not_evaluable', reason: s.horizonText ? `Horizon "${s.horizonText}" is not an explicit reporting period.` : 'No time horizon was stated.', ...none };
  }
  if (/\b(segment|division|business|vertical|o2c|retail|digital|jio|subsidiar)/i.test(s.quote)) {
    return { verdict: 'not_evaluable', reason: 'The target appears to refer to a segment or business line; only company-level figures are extracted.', ...none };
  }
  const period = horizonToPeriod(s.horizonPeriod);
  if (!period) return { verdict: 'not_evaluable', reason: `Horizon ${s.horizonPeriod} could not be mapped to a reporting period.`, ...none };

  const latest = facts.latestQuarterEnd();
  if (latest && period.end > latest) return { verdict: 'awaiting_results', reason: `${s.horizonPeriod} has not been reported yet (latest reported quarter ends ${latest}).`, ...none };

  if (s.targetUnit !== 'percent' || s.targetLow === null) {
    return { verdict: 'not_evaluable', reason: `Targets in ${s.targetUnit ?? 'unknown units'} are not evaluated automatically (needs an absolute baseline or a defined change).`, ...none };
  }
  const high = s.targetHigh ?? s.targetLow;

  let cell: DerivedCell;
  let label: string;
  if (s.subject === 'revenue_growth') {
    cell = facts.yoy('consolidated', 'revenue_from_operations', period.type, period.end);
    label = 'consolidated revenue growth YoY';
  } else if (s.subject === 'ebitda_margin') {
    cell = facts.margin('consolidated', 'ebitda', period.type, period.end);
    label = 'consolidated EBITDA margin';
  } else {
    return { verdict: 'not_evaluable', reason: `"${s.subject}" targets are not mapped to a reported metric.`, ...none };
  }
  if (cell.kind !== 'value') return { verdict: 'actual_unavailable', reason: `${label} for ${s.horizonPeriod}: ${cell.reason}.`, ...none };

  // Compare at the one-decimal precision the report shows, so "29.0% against 29–31%" can never read as below
  // the range because 0.29 × 100 is 28.999999999999996 in floating point.
  const actualPct = Math.round(cell.value * 1000) / 10;
  const { verdict, variancePp } = compare(actualPct, s.targetLow, high);
  return {
    verdict,
    reason: `${label} for ${s.horizonPeriod} was ${actualPct.toFixed(1)}% against ${s.targetLow === high ? `${s.targetLow}%` : `${s.targetLow}–${high}%`}.`,
    actual: { value: cell.value, unit: 'percent', formula: cell.formula, factLabels: cell.inputs.map((f) => `${f.metric} ${f.period.label} p.${f.sourceLocation.page ?? '?'}`), verified: cell.verified },
    variancePp: Math.round(variancePp * 100) / 100,
    method: `${cell.formula}; point targets met within ±${POINT_TOLERANCE_PP} pp`,
  };
}
