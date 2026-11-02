/**
 * Display formatting for financial values. Pure functions; no rounding happens
 * anywhere else in the UI. Calculations belong in src/domain, not here.
 */

export type CurrencyScale = 'one' | 'lakh' | 'crore';

const SCALE_DIVISOR: Record<CurrencyScale, number> = { one: 1, lakh: 1e5, crore: 1e7 };
const SCALE_SUFFIX: Record<CurrencyScale, string> = { one: '', lakh: ' L', crore: ' Cr' };

/** Minus sign (U+2212) rather than hyphen, so signs align in tabular columns. */
export const MINUS = '−';

function groupIndian(value: number, fractionDigits: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Math.abs(value));
}

/** Plain number with Indian digit grouping (12,34,567.8). */
export function formatNumber(value: number, fractionDigits = 0): string {
  const body = groupIndian(value, fractionDigits);
  return value < 0 && body !== groupIndian(0, fractionDigits) ? `${MINUS}${body}` : body;
}

/**
 * Rupee amount from an absolute INR value, expressed in the requested scale.
 * formatInr(2_354_810_000_000, { scale: 'crore' }) → "₹2,35,481 Cr"
 */
export function formatInr(
  valueInr: number,
  { scale = 'crore', fractionDigits }: { scale?: CurrencyScale; fractionDigits?: number } = {},
): string {
  const scaled = valueInr / SCALE_DIVISOR[scale];
  const digits = fractionDigits ?? (scale === 'one' ? 2 : 0);
  const body = groupIndian(scaled, digits);
  const sign = scaled < 0 && body !== groupIndian(0, digits) ? MINUS : '';
  return `${sign}₹${body}${SCALE_SUFFIX[scale]}`;
}

/** Signed percentage from a ratio: 0.0421 → "+4.2%", −0.1 → "−10.0%", 0 → "0.0%". */
export function formatSignedPercent(ratio: number, fractionDigits = 1): string {
  const pct = ratio * 100;
  const body = Math.abs(pct).toFixed(fractionDigits);
  if (Number(body) === 0) return `${(0).toFixed(fractionDigits)}%`;
  return `${pct > 0 ? '+' : MINUS}${body}%`;
}

/** Unsigned percentage from a ratio (for margins): 0.183 → "18.3%". */
export function formatPercent(ratio: number, fractionDigits = 1): string {
  const pct = ratio * 100;
  const body = Math.abs(pct).toFixed(fractionDigits);
  return `${pct < 0 && Number(body) !== 0 ? MINUS : ''}${body}%`;
}

/** Multiple, e.g. volume vs average: 3.14 → "3.1×". */
export function formatMultiple(value: number, fractionDigits = 1): string {
  return `${value.toFixed(fractionDigits)}×`;
}

export type Direction = 'up' | 'down' | 'flat';

/** Direction of a change after rounding to the displayed precision. */
export function directionOf(ratio: number, fractionDigits = 1): Direction {
  const rounded = Number((ratio * 100).toFixed(fractionDigits));
  if (rounded > 0) return 'up';
  if (rounded < 0) return 'down';
  return 'flat';
}

const IST = 'Asia/Kolkata';

// Month names are fixed here rather than taken from Intl: ICU versions differ
// ("Sep" vs "Sept"), which would make server and client renders disagree.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function istParts(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid ISO timestamp: ${iso}`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    day: '2-digit',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: get('day'), month: MONTHS[Number(get('month')) - 1] ?? '', year: get('year'), hour: get('hour'), minute: get('minute') };
}

/** "31 Oct 2026, 15:42 IST" — absolute, unambiguous, timezone-labelled. */
export function formatDateTimeIst(iso: string): string {
  const p = istParts(iso);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} IST`;
}

/** "31 Oct 2026" in IST. */
export function formatDateIst(iso: string): string {
  const p = istParts(iso);
  return `${p.day} ${p.month} ${p.year}`;
}

/**
 * Relative age against an explicit reference time ("now" is passed in so the
 * output is deterministic and identical on server and client).
 */
export function formatAge(iso: string, nowIso: string): string {
  const seconds = Math.round((Date.parse(nowIso) - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) throw new RangeError('Invalid timestamp for formatAge');
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
