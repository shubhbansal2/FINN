import { extractHtml, extractPdf } from '@/data/documents/extract';
import { downloadDocument } from '@/data/documents/download';
import type { HttpDeps } from '@/data/http';
import type { Db } from '@/db/connection';
import { getDocument, recordVersion, saveExtraction, setDocumentAvailability, type DocumentRow, type ExtractionOutcome } from '@/db/repositories';
import { isPrimarySource } from '@/domain/documents';

export type DocumentProcessResult = {
  documentId: string;
  outcome: 'extracted' | 'partial' | 'no_text_layer' | 'extraction_failed' | 'download_failed' | 'skipped_policy' | 'duplicate';
  message: string | null;
  pageCount: number | null;
};

/**
 * Downloads one document (primary sources only), stores the bytes by hash,
 * and extracts page- or section-located text. Failures are recorded on the
 * document/version with the reason; nothing is treated as an empty document.
 */
export async function processDocument(db: Db, documentId: string, opts: { blobDir: string; now: () => Date; http?: HttpDeps }): Promise<DocumentProcessResult> {
  const doc: DocumentRow | null = getDocument(db, documentId);
  if (!doc) throw new Error(`Unknown document ${documentId}`);
  if (!isPrimarySource(doc.origin)) {
    return { documentId, outcome: 'skipped_policy', message: `${doc.origin} documents are not fetched or used as evidence`, pageCount: null };
  }

  const dl = await downloadDocument(doc.source_url, opts.blobDir, opts.http);
  const now = opts.now().toISOString();
  if (!dl.ok) {
    const availability = dl.error.kind === 'too_large' ? 'too_large' : dl.error.kind === 'unsupported_type' ? 'unsupported_type' : dl.error.kind === 'insecure_url' ? 'unavailable' : 'failed';
    setDocumentAvailability(db, documentId, availability, dl.error.message, now);
    return { documentId, outcome: 'download_failed', message: dl.error.message, pageCount: null };
  }

  setDocumentAvailability(db, documentId, 'fetched', null, now);
  const version = recordVersion(db, {
    documentId,
    sha256: dl.value.sha256,
    byteSize: dl.value.byteSize,
    mimeType: dl.value.mimeType,
    finalUrl: dl.value.finalUrl,
    blobPath: dl.value.blobPath,
    fetchedAt: now,
  });
  if (!version.created) {
    return { documentId, outcome: 'duplicate', message: 'content unchanged since the last fetch', pageCount: null };
  }

  const extraction: ExtractionOutcome = dl.value.mimeType === 'application/pdf' ? await extractPdf(dl.value.bytes) : extractHtml(dl.value.bytes.toString('utf8'));
  saveExtraction(db, version.versionId, extraction);
  const outcome = extraction.status === 'failed' ? 'extraction_failed' : extraction.status;
  const message = 'error' in extraction ? extraction.error : (extraction.note ?? (version.duplicateOf ? `same bytes as document ${version.duplicateOf}` : null));
  return { documentId, outcome, message, pageCount: extraction.pageCount };
}

