import { createHash } from 'node:crypto';

import type { Exchange } from './symbols';

/** An announcement as a source adapter reports it, before storage. Source text is never edited. */
export type AnnouncementInput = {
  companyId: string;
  exchange: Exchange;
  /** The exchange's own stable identifier, when the source exposes one. */
  exchangeRef: string | null;
  title: string;
  /** UTC ISO timestamp. */
  publishedAt: string;
  /** Timestamp exactly as the source printed it. */
  publishedAtRaw: string;
  /** Page or record where FINN found the announcement. */
  sourceUrl: string;
  /** Attached filing, if any. */
  documentUrl: string | null;
};

/** Collapses whitespace and case only; punctuation is kept so distinct filings stay distinct. */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Stable dedupe key.
 * - With an exchange reference: `<exchange>:<ref>` (authoritative).
 * - Without one: a conservative fallback over company, normalized title and
 *   the publication minute. Two filings must agree on all three to collapse,
 *   so near-duplicates with different titles or times are kept apart.
 */
export function announcementDedupeKey(a: Pick<AnnouncementInput, 'companyId' | 'exchange' | 'exchangeRef' | 'title' | 'publishedAt'>): string {
  if (a.exchangeRef) return `${a.exchange}:${a.exchangeRef}`;
  const minute = a.publishedAt.slice(0, 16); // YYYY-MM-DDTHH:MM
  const digest = createHash('sha256').update(`${a.companyId}\n${normalizeTitle(a.title)}\n${minute}`).digest('hex').slice(0, 32);
  return `fallback:${digest}`;
}

/** BSE attachment URLs carry a GUID that identifies the filing: AnnPdfOpen.aspx?Pname=<guid>.pdf or AttachLive/<guid>.pdf. */
export function bseAttachmentRef(url: string): string | null {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf/i.exec(url);
  return m?.[1]?.toLowerCase() ?? null;
}
