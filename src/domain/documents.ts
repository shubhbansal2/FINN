/**
 * Primary-document provenance. Pull-side analysis may use only documents the
 * company itself issued or filed with an exchange. Broker notes, news, rating
 * rationales and aggregator summaries are third-party and never evidence.
 */

export type DocumentKind = 'annual_report' | 'quarterly_results' | 'investor_presentation' | 'earnings_call_transcript' | 'announcement_attachment' | 'other';

export type DocumentOrigin =
  /** Hosted by NSE/BSE as a company filing. */
  | 'exchange_filed'
  /** Hosted on one of the company's own investor-relations domains (from config). */
  | 'company_issued'
  /** Known non-company source: rating agencies, aggregators, news, brokers. */
  | 'third_party'
  /** Any other host. Not fetched, not trusted, until a person confirms it. */
  | 'unverified_external';

const EXCHANGE_HOSTS = new Set(['www.bseindia.com', 'bseindia.com', 'www.nseindia.com', 'nseindia.com', 'archives.nseindia.com', 'nsearchives.nseindia.com']);

const THIRD_PARTY_SUFFIXES = [
  'screener.in',
  'crisil.com',
  'icra.in',
  'careratings.com',
  'careedge.in',
  'indiaratings.co.in',
  'brickworkratings.com',
  'acuite.in',
  'moneycontrol.com',
  'economictimes.indiatimes.com',
  'livemint.com',
  'business-standard.com',
  'trendlyne.com',
  'tickertape.in',
];

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function classifyDocumentOrigin(url: string, companyIrDomains: readonly string[]): DocumentOrigin {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'unverified_external';
    host = u.hostname.toLowerCase();
  } catch {
    // Not a URL at all.
    return 'unverified_external';
  }
  if (EXCHANGE_HOSTS.has(host)) return 'exchange_filed';
  if (companyIrDomains.some((d) => hostMatches(host, d.toLowerCase()))) return 'company_issued';
  if (THIRD_PARTY_SUFFIXES.some((d) => hostMatches(host, d))) return 'third_party';
  return 'unverified_external';
}

/** Whether a document may be fetched and used as evidence for company analysis. */
export function isPrimarySource(origin: DocumentOrigin): boolean {
  return origin === 'exchange_filed' || origin === 'company_issued';
}

/** An announcement's attachment is a results document when the filing is classified as results. */
export function attachmentKind(category: string): DocumentKind {
  return category === 'results' ? 'quarterly_results' : 'announcement_attachment';
}
