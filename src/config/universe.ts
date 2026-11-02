import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { companyIdFor, normalizeBseCode, normalizeNseSymbol, type ListingRef } from '@/domain/symbols';

const ReportingProfile = z.enum(['industrial', 'bank', 'nbfc', 'insurance']);
export type ReportingProfile = z.infer<typeof ReportingProfile>;

const CompanyEntry = z
  .object({
    name: z.string().trim().min(1).max(120),
    nse: z.string().optional(),
    bseCode: z.string().optional(),
    /** BSE trading symbol, if it differs from the NSE symbol. Used for provider tickers, e.g. Yahoo `<ticker>.BO`. */
    bseTicker: z.string().optional(),
    sector: z.string().trim().min(1).max(80),
    size: z.enum(['large', 'mid', 'small']),
    reportingProfile: ReportingProfile,
    /** Company investor-relations domains; documents from these hosts count as company-issued. */
    irDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
  })
  .refine((c) => c.nse || c.bseCode, { message: 'A company needs an NSE symbol or a BSE code' });

const UniverseFile = z.object({
  portfolio: z.array(CompanyEntry).min(1).max(40),
  research: z.array(CompanyEntry).max(10),
});

export type UniverseCompany = {
  id: string;
  name: string;
  sector: string;
  size: 'large' | 'mid' | 'small' | 'unknown';
  reportingProfile: ReportingProfile | 'unknown';
  irDomains: string[];
  listings: ListingRef[];
  role: 'portfolio' | 'research' | 'adhoc';
};

export type Universe = { portfolio: UniverseCompany[]; research: UniverseCompany[] };

export class UniverseConfigError extends Error {
  override name = 'UniverseConfigError';
}

function toCompany(entry: z.infer<typeof CompanyEntry>, role: UniverseCompany['role'], where: string): UniverseCompany {
  const listings: ListingRef[] = [];
  if (entry.nse) {
    const r = normalizeNseSymbol(entry.nse);
    if (!r.ok) throw new UniverseConfigError(`${where}: invalid NSE symbol "${entry.nse}" (${r.error.kind})`);
    listings.push({ exchange: 'NSE', symbol: r.value });
  }
  if (entry.bseCode) {
    const r = normalizeBseCode(entry.bseCode);
    if (!r.ok) throw new UniverseConfigError(`${where}: invalid BSE code "${entry.bseCode}" (${r.error.kind})`);
    const tickerInput = entry.bseTicker ?? entry.nse;
    const ticker = tickerInput ? normalizeNseSymbol(tickerInput) : null;
    if (ticker && !ticker.ok) throw new UniverseConfigError(`${where}: invalid BSE ticker "${tickerInput}" (${ticker.error.kind})`);
    listings.push({ exchange: 'BSE', symbol: r.value, ...(ticker ? { ticker: ticker.value } : {}) });
  }
  return {
    id: companyIdFor(listings),
    name: entry.name,
    sector: entry.sector,
    size: entry.size,
    reportingProfile: entry.reportingProfile,
    irDomains: entry.irDomains,
    listings,
    role,
  };
}

/** Parses and validates a universe document. Throws UniverseConfigError with the offending entry. */
export function parseUniverse(raw: unknown): Universe {
  const parsed = UniverseFile.safeParse(raw);
  if (!parsed.success) {
    throw new UniverseConfigError(`Invalid universe config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const portfolio = parsed.data.portfolio.map((c, i) => toCompany(c, 'portfolio', `portfolio[${i}]`));
  const research = parsed.data.research.map((c, i) => toCompany(c, 'research', `research[${i}]`));
  const seen = new Set<string>();
  for (const c of [...portfolio, ...research]) {
    if (seen.has(c.id)) throw new UniverseConfigError(`Duplicate company in universe: ${c.id}`);
    seen.add(c.id);
  }
  return { portfolio, research };
}

export function loadUniverse(file = path.join(process.cwd(), 'config', 'universe.json')): Universe {
  return parseUniverse(JSON.parse(readFileSync(file, 'utf8')));
}
