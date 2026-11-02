import type { Db } from '@/db/connection';
import { getSegments, type VersionRow } from '@/db/repositories';

import { CHUNKER_VERSION, chunkSegments, type ChunkKind } from './chunk';

export type ChunkRow = {
  id: string;
  version_id: string;
  document_id: string;
  company_id: string;
  ordinal: number;
  page_start: number | null;
  page_end: number | null;
  section_heading: string | null;
  location_label: string;
  kind: ChunkKind;
  text: string;
};

/**
 * Chunks and indexes one extracted document version. Idempotent: a version
 * already indexed with the current chunker is left alone. Versions without
 * usable text (scanned, failed) are marked skipped, not indexed as empty.
 */
export function indexVersion(db: Db, version: Pick<VersionRow, 'id' | 'document_id' | 'extraction_status'>, companyId: string): { status: 'indexed' | 'skipped' | 'unchanged'; chunks: number } {
  const current = db.prepare(`SELECT index_status, chunker_version FROM document_version WHERE id = ?`).get(version.id) as
    | { index_status: string; chunker_version: string | null }
    | undefined;
  if (current?.index_status === 'indexed' && current.chunker_version === CHUNKER_VERSION) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM chunk WHERE version_id = ?`).get(version.id) as { n: number };
    return { status: 'unchanged', chunks: n.n };
  }
  if (version.extraction_status !== 'extracted' && version.extraction_status !== 'partial') {
    db.prepare(`UPDATE document_version SET index_status = 'skipped', chunker_version = ? WHERE id = ?`).run(CHUNKER_VERSION, version.id);
    return { status: 'skipped', chunks: 0 };
  }

  const drafts = chunkSegments(getSegments(db, version.id));
  db.transaction(() => {
    db.prepare(`DELETE FROM chunk WHERE version_id = ?`).run(version.id);
    const insert = db.prepare(
      `INSERT INTO chunk (id, version_id, document_id, company_id, ordinal, page_start, page_end, section_heading, location_label, kind, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    drafts.forEach((c, i) =>
      insert.run(`${version.id}:${i}`, version.id, version.document_id, companyId, i, c.pageStart, c.pageEnd, c.sectionHeading, c.locationLabel, c.kind, c.text),
    );
    db.prepare(`UPDATE document_version SET index_status = 'indexed', chunker_version = ? WHERE id = ?`).run(CHUNKER_VERSION, version.id);
  })();
  return { status: 'indexed', chunks: drafts.length };
}

const STOPWORDS = new Set(
  'the and for with that this from are was were has have had our its into over under about what which who whom whose how why when where will would can could should may might than then them they their there these those been being also such any all not but per'.split(
    ' ',
  ),
);

/** Turns free text into a safe FTS5 OR-query of quoted terms. User text never reaches FTS syntax unquoted. */
export function toFtsQuery(input: string | string[]): string | null {
  const phrases = (Array.isArray(input) ? input : input.split(/[^\p{L}\p{N}%&-]+/u))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 24);
  if (phrases.length === 0) return null;
  return [...new Set(phrases)].map((p) => `"${p.replace(/"/g, '""')}"`).join(' OR ');
}

export type ChunkHit = ChunkRow & { score: number; document_kind: string; document_title: string };

/** BM25 lexical retrieval, scoped to one company and optionally to document kinds or ids. */
export function searchChunks(
  db: Db,
  opts: { companyId: string; query: string | string[]; documentKinds?: string[]; documentIds?: string[]; limit?: number },
): ChunkHit[] {
  const fts = toFtsQuery(opts.query);
  if (!fts) return [];
  const kinds = opts.documentKinds ?? null;
  const ids = opts.documentIds ?? null;
  const rows = db
    .prepare(
      `SELECT c.*, bm25(chunk_fts) AS score, d.kind AS document_kind, d.title AS document_title
       FROM chunk_fts JOIN chunk c ON c.rowid = chunk_fts.rowid JOIN document d ON d.id = c.document_id
       WHERE chunk_fts MATCH @fts AND c.company_id = @companyId
         AND (@kinds IS NULL OR d.kind IN (SELECT value FROM json_each(@kinds)))
         AND (@ids IS NULL OR d.id IN (SELECT value FROM json_each(@ids)))
       ORDER BY score LIMIT @limit`,
    )
    .all({ fts, companyId: opts.companyId, kinds: kinds && JSON.stringify(kinds), ids: ids && JSON.stringify(ids), limit: opts.limit ?? 8 }) as ChunkHit[];
  return rows;
}

export function getChunk(db: Db, id: string): ChunkRow | null {
  return (db.prepare(`SELECT * FROM chunk WHERE id = ?`).get(id) as ChunkRow | undefined) ?? null;
}

export function chunksOfDocument(db: Db, documentId: string): ChunkRow[] {
  return db
    .prepare(`SELECT c.* FROM chunk c JOIN document_version v ON v.id = c.version_id WHERE c.document_id = ? AND v.id = (SELECT id FROM document_version WHERE document_id = ? ORDER BY fetched_at DESC LIMIT 1) ORDER BY c.ordinal`)
    .all(documentId, documentId) as ChunkRow[];
}
