import * as cheerio from 'cheerio';

import { screenerUrls } from '@/data/filings/screener';
import { defaultHttpDeps, describeHttpError, httpGet, type HttpDeps } from '@/data/http';
import { YahooChartAdapter } from '@/data/prices/yahoo';
import type { Db } from '@/db/connection';
import { listCompanies, setListingResolution, upsertCompany, type CompanyRow } from '@/db/repositories';
import { err, ok, type Result } from '@/domain/result';
import { companyIdFor, normalizeBseCode, normalizeNseSymbol } from '@/domain/symbols';

export type ResolveError =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'ambiguous'; message: string; candidates: { id: string; name: string; nseSymbol: string | null }[] }
  | { kind: 'not_found'; message: string }
  | { kind: 'unverifiable'; message: string };

export type Verification = { status: 'verified'; name: string } | { status: 'not_found'; message: string } | { status: 'unavailable'; message: string };

/**
 * Confirms an NSE symbol outside the registry against two independent sources:
 * the price provider must return INR daily data for `<SYMBOL>.NS`, and the
 * filings source must have a company page whose name we can read. Both must
 * agree before an ad-hoc company is created.
 */
export async function verifyNseSymbol(symbol: string, http: HttpDeps = defaultHttpDeps, now = new Date()): Promise<Verification> {
  const prices = await new YahooChartAdapter('3mo', http).fetchDaily(`${symbol}.NS`, now);
  if (prices.status === 'unavailable' && prices.reason === 'unresolved_symbol') return { status: 'not_found', message: `${symbol}.NS has no listing at the price provider` };
  if (prices.status === 'unavailable' || prices.status === 'invalid_payload') return { status: 'unavailable', message: `price provider check failed: ${prices.message}` };
  if (prices.bars.length === 0) return { status: 'not_found', message: `${symbol}.NS returned no completed sessions` };

  const [url] = screenerUrls({ companyId: '', nseSymbol: symbol, bseCode: null });
  if (!url) return { status: 'unavailable', message: 'no filings source URL' };
  const page = await httpGet(url, { accept: 'text/html', passStatuses: [404] }, http);
  if (!page.ok) return { status: 'unavailable', message: `filings source check failed: ${describeHttpError(page.error)}` };
  if (page.value.status === 404) return { status: 'not_found', message: `no filings page for ${symbol}` };
  const name = cheerio.load(page.value.body.toString('utf8'))('h1').first().text().replace(/\s+/g, ' ').trim();
  if (!name || name.length > 120) return { status: 'unavailable', message: 'company name could not be read from the filings page' };
  return { status: 'verified', name };
}

/**
 * Resolves a ticker, BSE code or company name to a registry company.
 * Unknown NSE symbols are verified live (if allowed) and added as `adhoc`.
 * Names matching several companies return the candidates instead of a guess.
 */
export async function resolveCompany(
  db: Db,
  input: string,
  opts: { allowLiveVerification: boolean; verify?: (symbol: string) => Promise<Verification>; now: () => Date },
): Promise<Result<CompanyRow, ResolveError>> {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 60) return err({ kind: 'invalid_input', message: 'Enter an NSE symbol (e.g. RELIANCE), a BSE code, or a company name.' });
  const companies = listCompanies(db);

  // The canonical company id (e.g. "nse:reliance") used by the feed and watchlist resolves to itself.
  const byId = companies.find((c) => c.id === raw);
  if (byId) return ok(byId);

  const bse = normalizeBseCode(raw);
  if (bse.ok) {
    const hit = companies.find((c) => c.bseCode === bse.value);
    return hit ? ok(hit) : err({ kind: 'not_found', message: `BSE code ${bse.value} is not in the registry. Research currently starts from NSE symbols.` });
  }

  const nse = normalizeNseSymbol(raw);
  if (nse.ok) {
    const hit = companies.find((c) => c.nseSymbol === nse.value);
    if (hit) return ok(hit);
  }

  // Name search (case-insensitive, whole input as substring).
  const needle = raw.toLowerCase();
  const byName = companies.filter((c) => c.name.toLowerCase().includes(needle));
  if (byName.length === 1 && byName[0]) return ok(byName[0]);
  if (byName.length > 1) {
    return err({
      kind: 'ambiguous',
      message: `"${raw}" matches ${byName.length} companies. Choose one by its NSE symbol.`,
      candidates: byName.slice(0, 8).map((c) => ({ id: c.id, name: c.name, nseSymbol: c.nseSymbol })),
    });
  }

  if (!nse.ok) return err({ kind: 'invalid_input', message: `"${raw}" is not a valid NSE symbol and matches no company name in the registry.` });
  if (!opts.allowLiveVerification) {
    return err({ kind: 'unverifiable', message: `${nse.value} is not in the registry, and live verification is off (demo mode). Switch to live mode to research unlisted symbols.` });
  }

  const verify = opts.verify ?? ((s: string) => verifyNseSymbol(s));
  const v = await verify(nse.value);
  if (v.status === 'not_found') return err({ kind: 'not_found', message: `${nse.value} could not be confirmed as an NSE-listed company: ${v.message}.` });
  if (v.status === 'unavailable') return err({ kind: 'unverifiable', message: `${nse.value} could not be verified right now: ${v.message}.` });

  const t = opts.now().toISOString();
  const listings = [{ exchange: 'NSE' as const, symbol: nse.value }];
  upsertCompany(db, { id: companyIdFor(listings), name: v.name, sector: 'Not classified', size: 'unknown', reportingProfile: 'unknown', irDomains: [], listings, role: 'adhoc' }, t);
  setListingResolution(db, `NSE:${nse.value}`, 'resolved', 'verified at research time', t);
  const created = listCompanies(db).find((c) => c.nseSymbol === nse.value);
  return created ? ok(created) : err({ kind: 'not_found', message: 'company could not be registered' });
}
