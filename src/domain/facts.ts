import { z } from 'zod';

import { err, ok, type Result } from './result';

/**
 * Financial facts with provenance. A fact is one value, for one metric, one
 * period, one statement basis, from one source location. Values are never
 * silently combined across bases, periods or units.
 */

// ---------------------------------------------------------------- units

export const UNIT_SCALES = ['one', 'thousand', 'lakh', 'million', 'crore', 'billion'] as const;
export type UnitScale = (typeof UNIT_SCALES)[number];

const SCALE_FACTOR: Record<UnitScale, number> = {
  one: 1,
  thousand: 1e3,
  lakh: 1e5,
  million: 1e6,
  crore: 1e7,
  billion: 1e9,
};

/** Converts a value as printed (e.g. 1,240.5 in ₹ crore) to base units (rupees). */
export function toBaseUnits(value: number, scale: UnitScale): number {
  return value * SCALE_FACTOR[scale];
}

/** Recognises the scale stated in a table header such as "(₹ in crore)" or "Rs. Lakhs". */
export function parseUnitScale(header: string): UnitScale | null {
  const h = header.toLowerCase();
  if (/\bcrores?\b|\bcr\.?\b/.test(h)) return 'crore';
  if (/\blakhs?\b|\blacs?\b/.test(h)) return 'lakh';
  if (/\bmillions?\b|\bmn\b/.test(h)) return 'million';
  if (/\bbillions?\b|\bbn\b/.test(h)) return 'billion';
  if (/\bthousands?\b|'000/.test(h)) return 'thousand';
  return null;
}

export type ParsedNumber = { kind: 'number'; value: number } | { kind: 'blank' } | { kind: 'unparseable'; raw: string };

/**
 * Parses a number as printed in an Indian financial statement:
 * "2,35,481.00" → 235481, "(1,204.5)" → −1204.5, "-" / "—" / "" → blank.
 */
export function parseReportedNumber(raw: string): ParsedNumber {
  const s = raw.trim().replace(/−/g, '-');
  if (s === '' || /^[-–—]+$/.test(s) || /^(nil|n\.?a\.?)$/i.test(s)) return { kind: 'blank' };
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  const digits = s.replace(/[(),\s₹]|rs\.?/gi, '').replace(/^-/, '');
  if (!/^\d+(\.\d+)?$/.test(digits)) return { kind: 'unparseable', raw };
  const value = Number(digits);
  return { kind: 'number', value: negative ? -value : value };
}

// ---------------------------------------------------------------- periods

export const PERIOD_TYPES = ['quarter', 'half_year', 'nine_months', 'financial_year'] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];

const MONTHS_IN: Record<PeriodType, number> = { quarter: 3, half_year: 6, nine_months: 9, financial_year: 12 };

/** A reporting period. Indian financial years run April–March; FY27 ends 31 Mar 2027. */
export type Period = {
  type: PeriodType;
  /** Inclusive, YYYY-MM-DD. */
  start: string;
  /** Inclusive, YYYY-MM-DD. */
  end: string;
  /** e.g. "Q2 FY27", "H1 FY27", "9M FY27", "FY27". */
  label: string;
};

function lastDayOfMonth(year: number, month1: number): string {
  const d = new Date(Date.UTC(year, month1, 0));
  return d.toISOString().slice(0, 10);
}

/** Fiscal year (ending March) that contains the given month. */
function fiscalYearOf(year: number, month1: number): number {
  return month1 >= 4 ? year + 1 : year;
}

export type PeriodError = { kind: 'non_standard_period_end'; end: string; type: PeriodType } | { kind: 'invalid_date'; value: string };

/**
 * Builds a standard April–March period from its end date. Non-standard
 * period ends are rejected rather than guessed.
 */
export function periodEnding(type: PeriodType, end: string): Result<Period, PeriodError> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!m) return err({ kind: 'invalid_date', value: end });
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (end !== lastDayOfMonth(year, month)) return err({ kind: 'non_standard_period_end', end, type });

  const fy = fiscalYearOf(year, month);
  const fyShort = String(fy % 100).padStart(2, '0');
  const monthsIntoFy = ((month - 4 + 12) % 12) + 1; // Apr=1 … Mar=12
  const span = MONTHS_IN[type];
  if (monthsIntoFy % 3 !== 0 || monthsIntoFy < span || (type === 'financial_year' && monthsIntoFy !== 12)) {
    return err({ kind: 'non_standard_period_end', end, type });
  }
  if ((type === 'half_year' && monthsIntoFy !== 6) || (type === 'nine_months' && monthsIntoFy !== 9)) {
    return err({ kind: 'non_standard_period_end', end, type });
  }

  const startMonthIndex = month - span; // 0-based month index of start, may be negative
  const startDate = new Date(Date.UTC(year, startMonthIndex, 1)).toISOString().slice(0, 10);
  const label =
    type === 'quarter'
      ? `Q${monthsIntoFy / 3} FY${fyShort}`
      : type === 'half_year'
        ? `H1 FY${fyShort}`
        : type === 'nine_months'
          ? `9M FY${fyShort}`
          : `FY${fyShort}`;
  return ok({ type, start: startDate, end, label });
}

function shiftMonthsEnd(end: string, months: number): string {
  const [y, m] = end.split('-').map(Number) as [number, number];
  const target = new Date(Date.UTC(y, m - 1 + months + 1, 0));
  return target.toISOString().slice(0, 10);
}

/** The quarter immediately before (for QoQ). Only defined for quarters. */
export function previousQuarter(period: Period): Period | null {
  if (period.type !== 'quarter') return null;
  const r = periodEnding('quarter', shiftMonthsEnd(period.end, -3));
  return r.ok ? r.value : null;
}

/** The same period one year earlier (for YoY). */
export function samePeriodLastYear(period: Period): Period | null {
  const r = periodEnding(period.type, shiftMonthsEnd(period.end, -12));
  return r.ok ? r.value : null;
}

// ---------------------------------------------------------------- facts

export const STATEMENT_BASES = ['consolidated', 'standalone'] as const;
export type StatementBasis = (typeof STATEMENT_BASES)[number];

export const VALUE_STATUSES = ['reported', 'derived', 'not_reported', 'not_applicable', 'unparseable', 'ambiguous'] as const;
export type ValueStatus = (typeof VALUE_STATUSES)[number];
const MISSING_STATUSES: ReadonlySet<ValueStatus> = new Set(['not_reported', 'not_applicable', 'unparseable', 'ambiguous']);

export const EXTRACTION_METHODS = ['llm_table_extraction', 'rule_parser', 'derived_formula', 'manual_entry'] as const;
export const VERIFICATION_STATUSES = ['unverified', 'checks_passed', 'check_failed', 'human_verified'] as const;

export const UNITS = ['currency', 'percent', 'ratio', 'count', 'days', 'per_share'] as const;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SourceLocation = z
  .object({
    page: z.number().int().positive().optional(),
    section: z.string().max(200).optional(),
    tableLabel: z.string().max(200).optional(),
    rowLabel: z.string().max(200).optional(),
    columnLabel: z.string().max(200).optional(),
  })
  .refine((l) => l.page !== undefined || l.section !== undefined, { message: 'A source location needs a page or a section' });

/**
 * Validated shape of a financial fact. Invariants enforced here (and again
 * by CHECK constraints in the database):
 * - a value is present iff the status is `reported` or `derived`;
 * - currency facts carry a currency and the scale they were printed in;
 * - the printed value is kept alongside the normalized one.
 */
export const FinancialFactSchema = z
  .object({
    companyId: z.string().min(1),
    metric: z.string().regex(/^[a-z][a-z0-9_]*$/),
    basis: z.enum(STATEMENT_BASES),
    period: z.object({ type: z.enum(PERIOD_TYPES), start: IsoDate, end: IsoDate, label: z.string().min(1) }),
    status: z.enum(VALUE_STATUSES),
    /** Normalized value in base units (rupees for currency), or null when missing. */
    value: z.number().finite().nullable(),
    /** Value exactly as printed, e.g. "(1,204.50)". */
    reportedText: z.string().max(64).nullable(),
    /** Numeric value as printed, before scaling. */
    reportedValue: z.number().finite().nullable(),
    unit: z.enum(UNITS),
    reportedScale: z.enum(UNIT_SCALES).nullable(),
    currency: z.string().length(3).nullable(),
    sourceDocumentId: z.string().min(1),
    sourceLocation: SourceLocation,
    extractionMethod: z.enum(EXTRACTION_METHODS),
    extractorVersion: z.string().min(1),
    verificationStatus: z.enum(VERIFICATION_STATUSES),
    verificationNote: z.string().max(500).nullable().default(null),
    /** Set when the source marks this figure as restated. */
    restated: z.boolean().default(false),
    ingestedAt: z.string().datetime(),
  })
  .superRefine((f, ctx) => {
    const missing = MISSING_STATUSES.has(f.status);
    if (missing && f.value !== null) ctx.addIssue({ code: 'custom', message: `status ${f.status} must not carry a value`, path: ['value'] });
    if (!missing && f.value === null) ctx.addIssue({ code: 'custom', message: `status ${f.status} requires a value`, path: ['value'] });
    if (f.unit === 'currency') {
      if (!f.currency) ctx.addIssue({ code: 'custom', message: 'currency facts need a currency', path: ['currency'] });
      if (f.status === 'reported' && !f.reportedScale) ctx.addIssue({ code: 'custom', message: 'reported currency facts need the printed scale', path: ['reportedScale'] });
    }
    if (f.status === 'reported' && (f.reportedValue === null || f.reportedText === null)) {
      ctx.addIssue({ code: 'custom', message: 'reported facts keep the printed value', path: ['reportedValue'] });
    }
    if (f.status === 'reported' && f.reportedValue !== null && f.value !== null && f.unit === 'currency' && f.reportedScale) {
      const expected = toBaseUnits(f.reportedValue, f.reportedScale);
      if (Math.abs(expected - f.value) > Math.max(1, Math.abs(expected) * 1e-9)) {
        ctx.addIssue({ code: 'custom', message: 'normalized value does not match printed value × scale', path: ['value'] });
      }
    }
    if (f.period.start > f.period.end) ctx.addIssue({ code: 'custom', message: 'period starts after it ends', path: ['period'] });
  });

export type FinancialFact = z.infer<typeof FinancialFactSchema>;

/** Builds a reported currency fact from a printed cell, normalizing with the printed scale. */
export function reportedCurrencyFact(
  input: Omit<FinancialFact, 'status' | 'value' | 'reportedText' | 'reportedValue' | 'unit' | 'reportedScale' | 'currency' | 'verificationNote' | 'restated'> & {
    printed: string;
    scale: UnitScale;
    currency?: string;
    restated?: boolean;
  },
): FinancialFact {
  const parsed = parseReportedNumber(input.printed);
  const common = {
    companyId: input.companyId,
    metric: input.metric,
    basis: input.basis,
    period: input.period,
    unit: 'currency' as const,
    currency: input.currency ?? 'INR',
    sourceDocumentId: input.sourceDocumentId,
    sourceLocation: input.sourceLocation,
    extractionMethod: input.extractionMethod,
    extractorVersion: input.extractorVersion,
    verificationStatus: input.verificationStatus,
    verificationNote: null,
    restated: input.restated ?? false,
    ingestedAt: input.ingestedAt,
  };
  if (parsed.kind === 'number') {
    return FinancialFactSchema.parse({
      ...common,
      status: 'reported',
      value: toBaseUnits(parsed.value, input.scale),
      reportedText: input.printed.trim(),
      reportedValue: parsed.value,
      reportedScale: input.scale,
    });
  }
  return FinancialFactSchema.parse({
    ...common,
    status: parsed.kind === 'blank' ? 'not_reported' : 'unparseable',
    value: null,
    reportedText: input.printed.trim() || null,
    reportedValue: null,
    reportedScale: input.scale,
  });
}

// ---------------------------------------------------------------- comparability

export type IncomparableReason =
  | 'different_company'
  | 'different_metric'
  | 'basis_mismatch'
  | 'period_type_mismatch'
  | 'unit_mismatch'
  | 'currency_mismatch'
  | 'missing_value'
  | 'not_prior_period';

/**
 * Two facts may be compared (growth, difference) only if they describe the
 * same company and metric on the same basis, period type, unit and currency,
 * and both carry a value.
 */
export function checkComparable(a: FinancialFact, b: FinancialFact): Result<{ current: number; base: number }, IncomparableReason> {
  if (a.companyId !== b.companyId) return err('different_company');
  if (a.metric !== b.metric) return err('different_metric');
  if (a.basis !== b.basis) return err('basis_mismatch');
  if (a.period.type !== b.period.type) return err('period_type_mismatch');
  if (a.unit !== b.unit) return err('unit_mismatch');
  if (a.currency !== b.currency) return err('currency_mismatch');
  if (a.value === null || b.value === null) return err('missing_value');
  return ok({ current: a.value, base: b.value });
}

export type Growth = { kind: 'ratio'; value: number } | { kind: 'not_meaningful'; reason: 'non_positive_base' } | { kind: 'not_computable'; reason: IncomparableReason };

/** growth.v1 — (current − base) / base, defined only for a positive base. */
export function growth(current: FinancialFact, base: FinancialFact, relation: 'qoq' | 'yoy'): Growth {
  const expected = relation === 'qoq' ? previousQuarter(current.period) : samePeriodLastYear(current.period);
  if (!expected || expected.end !== base.period.end || expected.type !== base.period.type) {
    return { kind: 'not_computable', reason: 'not_prior_period' };
  }
  const c = checkComparable(current, base);
  if (!c.ok) return { kind: 'not_computable', reason: c.error };
  if (c.value.base <= 0) return { kind: 'not_meaningful', reason: 'non_positive_base' };
  return { kind: 'ratio', value: (c.value.current - c.value.base) / c.value.base };
}

// ---------------------------------------------------------------- resolution

export type ResolvedFact =
  | { kind: 'value'; fact: FinancialFact; alternatives: FinancialFact[] }
  | { kind: 'missing'; facts: FinancialFact[] }
  | { kind: 'conflict'; candidates: FinancialFact[] }
  | { kind: 'none' };

/** Same reported figure, allowing for rounding at the printed precision. */
function sameFigure(a: FinancialFact, b: FinancialFact): boolean {
  if (a.value === null || b.value === null) return false;
  const tolerance = Math.max(Math.abs(a.value), Math.abs(b.value)) * 0.0005;
  const scaleTolerance = a.reportedScale ? SCALE_FACTOR[a.reportedScale] * 0.5 : 0.5;
  return Math.abs(a.value - b.value) <= Math.max(tolerance, scaleTolerance);
}

/**
 * Resolves several sources for one (company, metric, basis, period) into a
 * single figure, an explicit conflict, or an explicit absence.
 * - Facts on different bases or periods are never resolved together.
 * - A restated figure supersedes non-restated ones.
 * - Disagreeing figures are a conflict; FINN does not pick one silently.
 */
export function resolveFact(facts: FinancialFact[]): ResolvedFact {
  if (facts.length === 0) return { kind: 'none' };
  const [first] = facts;
  if (!first) return { kind: 'none' };
  const mixed = facts.some(
    (f) => f.companyId !== first.companyId || f.metric !== first.metric || f.basis !== first.basis || f.period.end !== first.period.end || f.period.type !== first.period.type,
  );
  if (mixed) throw new Error('resolveFact received facts for different keys; group by company, metric, basis and period first');

  const withValue = facts.filter((f) => f.value !== null);
  if (withValue.length === 0) return { kind: 'missing', facts };

  const restated = withValue.filter((f) => f.restated);
  const pool = restated.length > 0 ? restated : withValue;
  const [head, ...rest] = pool;
  if (!head) return { kind: 'missing', facts };
  if (rest.every((f) => sameFigure(head, f))) {
    return { kind: 'value', fact: head, alternatives: facts.filter((f) => f !== head) };
  }
  return { kind: 'conflict', candidates: pool };
}
