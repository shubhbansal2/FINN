import type { HttpDeps } from '@/data/http';
import type { Db } from '@/db/connection';
import { latestVersion, pagesOfVersion } from '@/db/repositories';
import type { LlmClient } from '@/llm/client';
import { PEOPLE_EXTRACTOR_VERSION, readPeople, type PeopleRead } from '@/push/people';
import type { PersonChange } from '@/push/types';

import { processDocument } from './documents';

export type PeopleIngestSummary = {
  documentId: string;
  companyId: string;
  title: string;
  outcome: PeopleRead['status'] | 'already_read' | 'download_failed' | 'no_text' | 'skipped';
  people: number;
  message: string | null;
};

type Candidate = { id: string; company_id: string; title: string; availability: string };

/** The stored, verified people for a filing's latest version, or null if it has not been read. */
export function peopleForDocument(db: Db, documentId: string): PersonChange[] | null {
  const v = latestVersion(db, documentId);
  if (!v) return null;
  const row = db.prepare(`SELECT status, people FROM filing_people WHERE version_id = ? AND extractor_version = ?`).get(v.id, PEOPLE_EXTRACTOR_VERSION) as
    | { status: string; people: string }
    | undefined;
  if (!row || (row.status !== 'ok' && row.status !== 'none')) return null;
  return JSON.parse(row.people) as PersonChange[];
}

/**
 * Management-change filings from recent announcements: downloaded, read for
 * who changes and their background, and stored per version. A filing is read
 * once per version; a model that was unavailable or failed is retried on the
 * next run.
 */
export async function ingestPeopleChanges(
  db: Db,
  opts: { since: string; companyIds: Set<string>; blobDir: string; now: () => Date; llm: LlmClient; limit: number; pauseMs: number; sleep: (ms: number) => Promise<void>; http?: HttpDeps },
): Promise<PeopleIngestSummary[]> {
  const candidates = (
    db
      .prepare(
        `SELECT DISTINCT d.id, d.company_id, d.title, d.availability
         FROM announcement a
         JOIN document d ON d.source_url = a.document_url
         WHERE a.published_at >= ? AND d.duplicate_of IS NULL
           AND (SELECT category FROM announcement_classification WHERE announcement_id = a.id ORDER BY classified_at DESC LIMIT 1) = 'management_change'
         ORDER BY a.published_at DESC`,
      )
      .all(opts.since) as Candidate[]
  )
    .filter((d) => opts.companyIds.has(d.company_id))
    .slice(0, opts.limit);

  const upsert = db.prepare(
    `INSERT INTO filing_people (version_id, document_id, extractor_version, status, people, rejected, model, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version_id, extractor_version) DO UPDATE SET status = excluded.status, people = excluded.people, rejected = excluded.rejected,
       model = excluded.model, note = excluded.note, created_at = excluded.created_at`,
  );

  const out: PeopleIngestSummary[] = [];
  for (const doc of candidates) {
    const base = { documentId: doc.id, companyId: doc.company_id, title: doc.title, people: 0, message: null };
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

    const version = latestVersion(db, doc.id);
    if (!version || (version.extraction_status !== 'extracted' && version.extraction_status !== 'partial')) {
      out.push({ ...base, outcome: 'no_text', message: version ? `extraction ${version.extraction_status}` : 'not downloaded' });
      continue;
    }
    const known = peopleForDocument(db, doc.id);
    if (known) {
      out.push({ ...base, outcome: 'already_read', people: known.length });
      continue;
    }
    const read = await readPeople(opts.llm, pagesOfVersion(db, version.id));
    upsert.run(version.id, doc.id, PEOPLE_EXTRACTOR_VERSION, read.status, JSON.stringify(read.people), read.rejected, read.model, read.note, opts.now().toISOString());
    out.push({ ...base, outcome: read.status, people: read.people.length, message: read.note });
  }
  return out;
}
