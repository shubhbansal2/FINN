import { err, ok, type Result } from './result';

/**
 * Exchange identifiers and provider ticker formats.
 *
 * - NSE symbols are upper-case alphanumerics that may contain `&` or `-`
 *   (e.g. `M&M`, `BAJAJ-AUTO`). Max 20 characters.
 * - BSE scrip codes are 6-digit numbers (e.g. `500325`).
 * - Yahoo Finance uses `<NSE symbol>.NS` and `<BSE trading symbol>.BO`.
 *   Verified 2026-11-01: `RELIANCE.BO` resolves, `500325.BO` (the scrip
 *   code) returns 404. A BSE listing therefore carries both identifiers.
 *
 * Nothing here checks that a symbol is actually listed; that requires a
 * provider round-trip (see `universe:verify`).
 */

export type Exchange = 'NSE' | 'BSE';

export type SymbolError =
  | { kind: 'empty' }
  | { kind: 'invalid_characters'; input: string }
  | { kind: 'too_long'; input: string }
  | { kind: 'wrong_exchange_suffix'; input: string; expected: Exchange };

const NSE_SYMBOL = /^[A-Z0-9][A-Z0-9&-]*$/;
const BSE_CODE = /^\d{6}$/;
const MAX_SYMBOL_LENGTH = 20;

/** Accepts `reliance`, ` RELIANCE.NS `, `NSE:RELIANCE`; rejects BSE-suffixed input and junk. */
export function normalizeNseSymbol(input: string): Result<string, SymbolError> {
  let s = input.trim().toUpperCase();
  if (s.startsWith('NSE:')) s = s.slice(4);
  if (s.endsWith('.BO')) return err({ kind: 'wrong_exchange_suffix', input, expected: 'NSE' });
  if (s.endsWith('.NS')) s = s.slice(0, -3);
  if (s.length === 0) return err({ kind: 'empty' });
  if (s.length > MAX_SYMBOL_LENGTH) return err({ kind: 'too_long', input });
  if (!NSE_SYMBOL.test(s)) return err({ kind: 'invalid_characters', input });
  return ok(s);
}

/** Accepts `500325`, `500325.BO`, `BSE:500325`. */
export function normalizeBseCode(input: string): Result<string, SymbolError> {
  let s = input.trim().toUpperCase();
  if (s.startsWith('BSE:')) s = s.slice(4);
  if (s.endsWith('.NS')) return err({ kind: 'wrong_exchange_suffix', input, expected: 'BSE' });
  if (s.endsWith('.BO')) s = s.slice(0, -3);
  if (s.length === 0) return err({ kind: 'empty' });
  if (!BSE_CODE.test(s)) return err({ kind: 'invalid_characters', input });
  return ok(s);
}

/**
 * `symbol` is the exchange's identifier (NSE symbol, or BSE scrip code).
 * `ticker` is the BSE trading symbol, which providers such as Yahoo use; it
 * is unset for NSE listings and may be unknown for a BSE listing.
 */
export type ListingRef = { exchange: Exchange; symbol: string; ticker?: string };

/**
 * Yahoo Finance ticker for a listing, or null when no mapping is known
 * (a BSE listing without a trading symbol). Never guesses from the scrip code.
 */
export function toYahooSymbol(listing: ListingRef): string | null {
  if (listing.exchange === 'NSE') return `${listing.symbol}.NS`;
  return listing.ticker ? `${listing.ticker}.BO` : null;
}

/** Stable internal company id derived from the NSE symbol (or BSE code if NSE-unlisted). */
export function companyIdFor(listings: ListingRef[]): string {
  const nse = listings.find((l) => l.exchange === 'NSE');
  const primary = nse ?? listings[0];
  if (!primary) throw new Error('A company needs at least one listing');
  return `${primary.exchange.toLowerCase()}:${primary.symbol.toLowerCase()}`;
}
