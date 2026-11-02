import type { FilingsAdapter } from '@/data/filings/types';
import type { Db } from '@/db/connection';
import { finishFetch, insertAnnouncement, registerDocument, saveClassification, startFetch, type CompanyRow } from '@/db/repositories';
import { attachmentKind, classifyDocumentOrigin } from '@/domain/documents';
import { classifyAnnouncement } from '@/domain/taxonomy';

export type FilingsIngestSummary = {
  companyId: string;
  outcome: 'stored' | 'unavailable' | 'invalid_payload';
  announcementsInserted: number;
  announcementsDuplicate: number;
  documentsRegistered: number;
  warnings: string[];
  message: string | null;
};

export function filingsRequestKey(companyId: string): string {
  return `filings:${companyId}`;
}

/**
 * Stores listed announcements (deduplicated, classified alongside — never
 * over — the filed text) and registers discovered documents with their
 * origin. Nothing is fabricated: an empty or failed source leaves the feed empty.
 */
export async function ingestFilings(db: Db, adapter: FilingsAdapter, companies: CompanyRow[], opts: { now: () => Date; pauseMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<FilingsIngestSummary[]> {
  const out: FilingsIngestSummary[] = [];
  for (const [i, company] of companies.entries()) {
    if (i > 0 && opts.pauseMs && opts.sleep) await opts.sleep(opts.pauseMs);
    const started = opts.now();
    const fetchId = startFetch(db, { provider: adapter.provider, dataMode: adapter.dataMode, requestKey: filingsRequestKey(company.id), now: started.toISOString() });
    const r = await adapter.fetchCompany({ companyId: company.id, nseSymbol: company.nseSymbol, bseCode: company.bseCode }, started);
    const now = opts.now().toISOString();
    const base = { companyId: company.id, announcementsInserted: 0, announcementsDuplicate: 0, documentsRegistered: 0, warnings: [] as string[] };

    if (r.status === 'unavailable' || r.status === 'invalid_payload') {
      finishFetch(db, fetchId, { status: r.status, httpStatus: r.httpStatus, error: r.message, now });
      out.push({ ...base, outcome: r.status, message: r.message });
      continue;
    }

    const summary = { ...base, outcome: 'stored' as const, warnings: r.warnings, message: null };
    db.transaction(() => {
      for (const a of r.announcements) {
        const inserted = insertAnnouncement(
          db,
          {
            companyId: company.id,
            exchange: a.exchange,
            exchangeRef: a.exchangeRef,
            title: a.title,
            publishedAt: a.publishedAt,
            publishedAtRaw: a.publishedAtRaw,
            sourceUrl: r.pageUrl,
            documentUrl: a.url,
          },
          { provider: adapter.provider, fetchId, now },
        );
        if (inserted.status === 'duplicate') {
          summary.announcementsDuplicate += 1;
          continue;
        }
        summary.announcementsInserted += 1;
        const classification = classifyAnnouncement(a.title);
        saveClassification(db, inserted.id, classification, now);
        const doc = registerDocument(
          db,
          {
            companyId: company.id,
            kind: attachmentKind(classification.category),
            title: a.title,
            periodLabel: null,
            publishedAt: a.publishedAt,
            sourceUrl: a.url,
            discoveredVia: `${adapter.provider}:announcement`,
            origin: classifyDocumentOrigin(a.url, company.irDomains),
          },
          now,
        );
        if (doc.created) summary.documentsRegistered += 1;
      }
      for (const d of r.documents) {
        const doc = registerDocument(
          db,
          { companyId: company.id, kind: d.kind, title: d.title, periodLabel: d.periodLabel, publishedAt: d.publishedAt, sourceUrl: d.url, discoveredVia: `${adapter.provider}:documents`, origin: classifyDocumentOrigin(d.url, company.irDomains) },
          now,
        );
        if (doc.created) summary.documentsRegistered += 1;
      }
    })();
    finishFetch(db, fetchId, {
      status: r.status,
      itemCount: r.announcements.length + r.documents.length,
      rejectedCount: r.warnings.length,
      error: r.warnings.length ? r.warnings.join('; ') : null,
      now,
    });
    out.push(summary);
  }
  return out;
}
