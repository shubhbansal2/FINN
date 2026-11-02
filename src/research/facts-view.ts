import { periodEnding, resolveFact, type FinancialFact, type PeriodType, type StatementBasis } from '@/domain/facts';

/**
 * Read model over extracted facts. Deterministic: every derived figure names
 * its formula and the facts it used. Bases and period types are never mixed.
 */

export type FactCell =
  | { kind: 'value'; value: number; fact: FinancialFact; agreeing: number; verified: boolean }
  | { kind: 'conflict'; candidates: FinancialFact[] }
  | { kind: 'missing'; reason: string };

export type DerivedCell =
  | { kind: 'value'; value: number; formula: string; inputs: FinancialFact[]; verified: boolean }
  | { kind: 'not_computable'; reason: string };

const key = (basis: StatementBasis, metric: string, type: PeriodType, end: string) => `${basis}|${metric}|${type}|${end}`;

export class FactsView {
  private readonly groups = new Map<string, FinancialFact[]>();

  constructor(readonly facts: FinancialFact[]) {
    for (const f of facts) {
      const k = key(f.basis, f.metric, f.period.type, f.period.end);
      const g = this.groups.get(k) ?? [];
      g.push(f);
      this.groups.set(k, g);
    }
  }

  /** Periods with at least one fact on this basis, newest first. */
  periods(basis: StatementBasis, type: PeriodType): string[] {
    const ends = new Set(this.facts.filter((f) => f.basis === basis && f.period.type === type).map((f) => f.period.end));
    return [...ends].sort().reverse();
  }

  /**
   * One figure per key. Facts that passed arithmetic checks are preferred;
   * if none passed, unverified facts are used and flagged; `check_failed`
   * facts are used only to detect conflicts, never as the displayed value.
   */
  get(basis: StatementBasis, metric: string, type: PeriodType, end: string): FactCell {
    const group = this.groups.get(key(basis, metric, type, end)) ?? [];
    if (group.length === 0) return { kind: 'missing', reason: 'not reported in the retrieved filings' };
    const passed = group.filter((f) => f.verificationStatus === 'checks_passed' || f.verificationStatus === 'human_verified');
    const unverified = group.filter((f) => f.verificationStatus === 'unverified');
    const pool = passed.length ? passed : unverified;
    if (pool.length === 0) return { kind: 'missing', reason: 'only figures that failed consistency checks were found' };
    const resolved = resolveFact(pool);
    if (resolved.kind === 'conflict') return { kind: 'conflict', candidates: resolved.candidates };
    if (resolved.kind !== 'value' || resolved.fact.value === null) return { kind: 'missing', reason: 'value not reported' };
    // An unverified figure confirmed by an independent location counts as verified.
    const agreeing = 1 + resolved.alternatives.filter((a) => a.value === resolved.fact.value).length;
    const verified = passed.length > 0 || agreeing >= 2;
    return { kind: 'value', value: resolved.fact.value, fact: resolved.fact, agreeing, verified };
  }

  /** ebitda.v1 = PBT + finance costs + depreciation & amortisation (includes other income). */
  ebitda(basis: StatementBasis, type: PeriodType, end: string): DerivedCell {
    const parts = ['pbt', 'finance_costs', 'depreciation_amortisation'].map((m) => [m, this.get(basis, m, type, end)] as const);
    for (const [m, c] of parts) {
      if (c.kind === 'conflict') return { kind: 'not_computable', reason: `${m} has conflicting sources` };
      if (c.kind === 'missing') return { kind: 'not_computable', reason: `${m} not available (${c.reason})` };
    }
    const cells = parts.map(([, c]) => c as Extract<FactCell, { kind: 'value' }>);
    return {
      kind: 'value',
      value: cells.reduce((s, c) => s + c.value, 0),
      formula: 'EBITDA = PBT + finance costs + depreciation & amortisation (ebitda.v1; includes other income)',
      inputs: cells.map((c) => c.fact),
      verified: cells.every((c) => c.verified),
    };
  }

  /** margin.v1 = numerator ÷ revenue from operations, same basis and period. */
  margin(basis: StatementBasis, numerator: 'ebitda' | 'profit_after_tax' | 'pbt', type: PeriodType, end: string): DerivedCell {
    const rev = this.get(basis, 'revenue_from_operations', type, end);
    if (rev.kind !== 'value') return { kind: 'not_computable', reason: rev.kind === 'conflict' ? 'revenue has conflicting sources' : `revenue not available (${rev.reason})` };
    if (rev.value <= 0) return { kind: 'not_computable', reason: 'revenue is not positive' };
    if (numerator === 'ebitda') {
      const e = this.ebitda(basis, type, end);
      if (e.kind !== 'value') return e;
      return { kind: 'value', value: e.value / rev.value, formula: `EBITDA margin = EBITDA ÷ revenue from operations (margin.v1)`, inputs: [...e.inputs, rev.fact], verified: e.verified && rev.verified };
    }
    const n = this.get(basis, numerator, type, end);
    if (n.kind !== 'value') return { kind: 'not_computable', reason: `${numerator} not available` };
    const label = numerator === 'pbt' ? 'PBT margin = PBT' : 'PAT margin = profit after tax';
    return { kind: 'value', value: n.value / rev.value, formula: `${label} ÷ revenue from operations (margin.v1)`, inputs: [n.fact, rev.fact], verified: n.verified && rev.verified };
  }

  /** growth.v1 against the same period one year earlier; defined only for a positive base. */
  yoy(basis: StatementBasis, metric: string, type: PeriodType, end: string): DerivedCell {
    const prior = periodEnding(type, `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`.replace(/-02-29$/, '-02-28'));
    if (!prior.ok) return { kind: 'not_computable', reason: 'prior period could not be determined' };
    const cur = this.get(basis, metric, type, end);
    const base = this.get(basis, metric, type, prior.value.end);
    if (cur.kind !== 'value') return { kind: 'not_computable', reason: `${metric} for the period not available` };
    if (base.kind !== 'value') return { kind: 'not_computable', reason: `${metric} for ${prior.value.label} not available` };
    if (base.value <= 0) return { kind: 'not_computable', reason: 'growth from a zero or negative base is not meaningful' };
    return { kind: 'value', value: (cur.value - base.value) / base.value, formula: 'YoY growth = (current − prior year) ÷ prior year (growth.v1)', inputs: [cur.fact, base.fact], verified: cur.verified && base.verified };
  }

  /** growth.v1 against the immediately preceding quarter. */
  qoq(basis: StatementBasis, metric: string, end: string): DerivedCell {
    const cur = periodEnding('quarter', end);
    if (!cur.ok) return { kind: 'not_computable', reason: 'period could not be determined' };
    const prevEnd = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 3, 0)).toISOString().slice(0, 10);
    const a = this.get(basis, metric, 'quarter', end);
    const b = this.get(basis, metric, 'quarter', prevEnd);
    if (a.kind !== 'value') return { kind: 'not_computable', reason: `${metric} for the quarter not available` };
    if (b.kind !== 'value') return { kind: 'not_computable', reason: `${metric} for the previous quarter not available` };
    if (b.value <= 0) return { kind: 'not_computable', reason: 'growth from a zero or negative base is not meaningful' };
    return { kind: 'value', value: (a.value - b.value) / b.value, formula: 'QoQ growth = (current − previous quarter) ÷ previous quarter (growth.v1)', inputs: [a.fact, b.fact], verified: a.verified && b.verified };
  }

  latestQuarterEnd(): string | null {
    return this.periods('consolidated', 'quarter')[0] ?? this.periods('standalone', 'quarter')[0] ?? null;
  }
}
