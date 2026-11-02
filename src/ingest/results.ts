import type { HttpDeps } from '@/data/http';
import type { Db } from '@/db/connection';
import { deleteFactsForDocument, getDocument, insertFact, latestVersion, pagesOfVersion } from '@/db/repositories';
import { parseResultsPages } from '@/research/results-parser';

import { processDocument } from './documents';

export type StoredResults = { quarterEnd: string | null; stored: number; diagnostics: string[] };

/**
 * Runs the deterministic, arithmetic-checked results parser over one extracted
 * version and replaces the document's facts with what it finds. Shared by the
 * research engine and the push-side results ingest, so both read a filing the
 * same way.
 */
export function storeResultsFacts(db: Db, doc: { id: string; company_id: string }, versionId: string, ingestedAt: string): StoredResults {
  const parsed = parseResultsPages(pagesOfVersion(db, versionId), { companyId: doc.company_id, documentId: doc.id, ingestedAt });
  const diagnostics = [...parsed.diagnostics];
  let stored = 0;
  db.transaction(() => {
    deleteFactsForDocument(db, doc.id);
    for (const f of parsed.facts) {
      try {
        insertFact(db, f);
        stored += 1;
      } catch (e) {
        diagnostics.push(`fact not stored (${f.metric} ${f.period.label}): ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
  })();
  return { quarterEnd: parsed.quarterEnd, stored, diagnostics };
}

export type ResultsIngestSummary = {
  documentId: string;
  companyId: string;
  title: string;
  outcome: 'parsed' | 'no_figures' | 'download_failed' | 'no_text' | 'skipped';
  stored: number;
  quarterEnd: string | null;
  message: string | null;
};

type Candidate = { id: string; company_id: string; title: string; availability: string };

/**
 * Results filings attached to recent announcements, downloaded and parsed so a
 * results signal can show its headline numbers without research being run
 * first. Already-downloaded filings are re-parsed from stored text (no network).
 */
export async function ingestResultsFilings(
  db: Db,
  opts: { since: string; companyIds: Set<string>; blobDir: string; now: () => Date; limit: number; pauseMs: number; sleep: (ms: number) => Promise<void>; http?: HttpDeps },
): Promise<ResultsIngestSummary[]> {
  const candidates = (
    db
      .prepare(
        `SELECT id, company_id, title, availability FROM document
         WHERE kind = 'quarterly_results' AND discovered_via LIKE '%:announcement' AND published_at >= ? AND duplicate_of IS NULL
         ORDER BY published_at DESC`,
      )
      .all(opts.since) as Candidate[]
  )
    .filter((d) => opts.companyIds.has(d.company_id))
    .slice(0, opts.limit);

  const out: ResultsIngestSummary[] = [];
  for (const doc of candidates) {
    const base = { documentId: doc.id, companyId: doc.company_id, title: doc.title, stored: 0, quarterEnd: null, message: null };
    if (doc.availability === 'pending' || doc.availability === 'failed') {
      const r = await processDocument(db, doc.id, { blobDir: opts.blobDir, now: opts.now, http: opts.http });
      await opts.sleep(opts.pauseMs);
      if (r.outcome === 'download_failed' || r.outcome === 'skipped_policy') {
        out.push({ ...base, outcome: r.outcome === 'skipped_policy' ? 'skipped' : 'download_failed', message: r.message });
        continue;
      }
    } else if (doc.availability !== 'fetched') {
      out.push({ ...base, outcome: 'skipped', message: `document is ${doc.availability}` });
      continue;
    }

    // A byte-identical copy of another filing carries the same figures; the original is used.
    if (getDocument(db, doc.id)?.duplicate_of) {
      out.push({ ...base, outcome: 'skipped', message: 'identical to another filing' });
      continue;
    }
    const version = latestVersion(db, doc.id);
    if (!version || (version.extraction_status !== 'extracted' && version.extraction_status !== 'partial')) {
      out.push({ ...base, outcome: 'no_text', message: version ? `extraction ${version.extraction_status}` : 'not downloaded' });
      continue;
    }
    const r = storeResultsFacts(db, doc, version.id, opts.now().toISOString());
    out.push({ ...base, outcome: r.stored > 0 ? 'parsed' : 'no_figures', stored: r.stored, quarterEnd: r.quarterEnd, message: r.diagnostics.slice(0, 2).join('; ') || null });
  }
  return out;
}
