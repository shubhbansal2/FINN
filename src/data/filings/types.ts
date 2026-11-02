import type { Exchange } from '@/domain/symbols';
import type { DocumentKind } from '@/domain/documents';

/** An announcement as listed by a source, before company attribution and storage. */
export type ListedAnnouncement = {
  exchange: Exchange;
  exchangeRef: string | null;
  /** Filed subject, exactly as listed. */
  title: string;
  publishedAt: string;
  publishedAtRaw: string;
  /** Link to the exchange filing (usually the attachment itself). */
  url: string;
};

export type DiscoveredDocument = {
  kind: DocumentKind;
  title: string;
  periodLabel: string | null;
  publishedAt: string | null;
  url: string;
};

export type FilingsResult =
  | {
      status: 'ok' | 'partial';
      pageUrl: string;
      fetchedAt: string;
      announcements: ListedAnnouncement[];
      documents: DiscoveredDocument[];
      warnings: string[];
    }
  | { status: 'unavailable'; reason: 'not_found' | 'http_error' | 'no_fixture'; message: string; httpStatus: number | null; fetchedAt: string }
  | { status: 'invalid_payload'; message: string; httpStatus: number | null; fetchedAt: string };

export type FilingsTarget = { companyId: string; nseSymbol: string | null; bseCode: string | null };

/** A source of a company's filings: exchange announcements plus primary-document links. */
export interface FilingsAdapter {
  readonly provider: string;
  readonly dataMode: 'live' | 'fixture';
  fetchCompany(target: FilingsTarget, now: Date): Promise<FilingsResult>;
}
