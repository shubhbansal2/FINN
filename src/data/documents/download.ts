import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { bseAttachmentRef } from '@/domain/announcements';
import { err, ok, type Result } from '@/domain/result';

import { defaultHttpDeps, describeHttpError, httpGet, type HttpDeps } from '../http';

export const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024;

export type DownloadedDocument = { sha256: string; byteSize: number; mimeType: 'application/pdf' | 'text/html'; finalUrl: string; blobPath: string; bytes: Buffer };

export type DownloadError =
  | { kind: 'unavailable'; message: string; httpStatus: number | null }
  | { kind: 'too_large'; message: string }
  | { kind: 'unsupported_type'; message: string }
  | { kind: 'insecure_url'; message: string };

/** Decides the type from the bytes, not only the header: exchanges sometimes serve PDFs as octet-stream. */
export function sniffType(bytes: Buffer, contentType: string): 'application/pdf' | 'text/html' | null {
  const head = bytes.subarray(0, 1024).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('%pdf-')) return 'application/pdf';
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || (contentType.includes('text/html') && head.startsWith('<'))) return 'text/html';
  return null;
}

/**
 * BSE serves a filing at AnnPdfOpen.aspx?Pname=<guid>.pdf, which redirects to
 * xml-data/corpfiling/AttachLive|AttachHis/<guid>.pdf. The redirector
 * intermittently returns a malformed HTTP response (observed 2026-11-01), so
 * the canonical attachment paths are tried as fallbacks. Same public file.
 */
export function bseFallbackUrls(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Not a URL: nothing to fall back to.
    return [];
  }
  if (u.hostname !== 'www.bseindia.com' || !/annpdfopen\.aspx$/i.test(u.pathname)) return [];
  const guid = bseAttachmentRef(url);
  if (!guid) return [];
  return [`https://www.bseindia.com/xml-data/corpfiling/AttachLive/${guid}.pdf`, `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${guid}.pdf`];
}

/** Downloads a document to the content-addressed blob store. Only https URLs are fetched. */
export async function downloadDocument(url: string, blobDir: string, deps: HttpDeps = defaultHttpDeps): Promise<Result<DownloadedDocument, DownloadError>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return err({ kind: 'insecure_url', message: 'not a valid URL' });
  }
  if (parsed.protocol !== 'https:') return err({ kind: 'insecure_url', message: `refusing ${parsed.protocol} URL` });

  const options = { accept: 'application/pdf,text/html;q=0.8', maxBytes: MAX_DOCUMENT_BYTES, timeoutMs: 60_000 };
  let res = await httpGet(url, options, deps);
  for (const fallback of bseFallbackUrls(url)) {
    if (res.ok || res.error.kind === 'too_large') break;
    res = await httpGet(fallback, { ...options, retries: 0 }, deps);
  }
  if (!res.ok) {
    if (res.error.kind === 'too_large') return err({ kind: 'too_large', message: describeHttpError(res.error) });
    return err({ kind: 'unavailable', message: describeHttpError(res.error), httpStatus: res.error.kind === 'status' ? res.error.status : null });
  }
  const { body, contentType, finalUrl } = res.value;
  if (body.length === 0) return err({ kind: 'unavailable', message: 'empty response body', httpStatus: res.value.status });
  const mimeType = sniffType(body, contentType);
  if (!mimeType) return err({ kind: 'unsupported_type', message: `unsupported content (${contentType || 'no content-type'})` });

  const sha256 = createHash('sha256').update(body).digest('hex');
  const blobPath = path.join(blobDir, sha256.slice(0, 2), `${sha256}${mimeType === 'application/pdf' ? '.pdf' : '.html'}`);
  await mkdir(path.dirname(blobPath), { recursive: true });
  const tmp = `${blobPath}.${process.pid}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, blobPath);
  return ok({ sha256, byteSize: body.length, mimeType, finalUrl, blobPath, bytes: body });
}
