import { formatInr, formatMultiple, formatNumber, formatPercent, type CurrencyScale } from './format';

/** Why a value is absent. Missing is never rendered as zero. */
export type MissingReason = 'not_reported' | 'not_applicable' | 'not_computable' | 'unparseable' | 'conflicting_sources';

export type DisplayValue =
  | { kind: 'currency'; valueInr: number; scale?: CurrencyScale; fractionDigits?: number }
  | { kind: 'percent'; ratio: number; fractionDigits?: number }
  | { kind: 'multiple'; value: number }
  | { kind: 'number'; value: number; fractionDigits?: number; unit?: string }
  | { kind: 'missing'; reason: MissingReason };

export const MISSING_LABEL: Record<MissingReason, string> = {
  not_reported: 'Not reported',
  not_applicable: 'Not applicable',
  not_computable: 'Not computable',
  unparseable: 'Could not be read',
  conflicting_sources: 'Sources disagree',
};

/** Text for a present value; `null` for a missing one so callers must handle it. */
export function formatDisplayValue(value: DisplayValue): string | null {
  switch (value.kind) {
    case 'currency':
      return formatInr(value.valueInr, { scale: value.scale ?? 'crore', fractionDigits: value.fractionDigits });
    case 'percent':
      return formatPercent(value.ratio, value.fractionDigits ?? 1);
    case 'multiple':
      return formatMultiple(value.value);
    case 'number':
      return `${formatNumber(value.value, value.fractionDigits ?? 0)}${value.unit ? ` ${value.unit}` : ''}`;
    case 'missing':
      return null;
  }
}
