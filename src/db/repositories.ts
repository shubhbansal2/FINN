import { randomUUID } from 'node:crypto';

import type { UniverseCompany } from '@/config/universe';
import { announcementDedupeKey, type AnnouncementInput } from '@/domain/announcements';
import { FinancialFactSchema, type FinancialFact, type Period, type StatementBasis } from '@/domain/facts';
import type { PriceBar } from '@/domain/market';
import type { DocumentKind, DocumentOrigin } from '@/domain/documents';
import { isPrimarySource } from '@/domain/documents';
import { toYahooSymbol, type Exchange } from '@/domain/symbols';
import type { Classification } from '@/domain/taxonomy';

import type { Db } from './connection';

export const newId = () => randomUUID();

// ------------------------------------------------------------ companies

export type ListingRow = {
  id: string;
  company_id: string;
  exchange: Exchange;
  symbol: string;
  provider_symbol: string | null;
  resolution_status: 'unverified' | 'resolved' | 'unresolved';
};

export function listingId(exchange: Exchange, symbol: string): string {
  return `${exchange}:${symbol}`;
}

/** Inserts or updates a company and its listings from the universe config. Idempotent. */
export function upsertCompany(db: Db, c: UniverseCompany, now: string): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO company (id, name, sector, size, reporting_profile, role, ir_domains, created_at, updated_at)
       VALUES (@id, @name, @sector, @size, @reportingProfile, @role, @irDomains, @now, @now)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, sector = excluded.sector, size = excluded.size,
         reporting_profile = excluded.reporting_profile, role = excluded.role, ir_domains = excluded.ir_domains, updated_at = excluded.updated_at`,
    ).run({ ...c, irDomains: JSON.stringify(c.irDomains), now });
    const insertListing = db.prepare(
      `INSERT INTO listing (id, company_id, exchange, symbol, provider_symbol)
       VALUES (@id, @companyId, @exchange, @symbol, @providerSymbol)
       ON CONFLICT(id) DO UPDATE SET company_id = excluded.company_id, provider_symbol = excluded.provider_symbol`,
    );
    for (const l of c.listings) {
      insertListing.run({ id: listingId(l.exchange, l.symbol), companyId: c.id, exchange: l.exchange, symbol: l.symbol, providerSymbol: toYahooSymbol(l) });
    }
  })();
}

export type CompanyRow = {
  id: string;
  name: string;
  role: 'portfolio' | 'research' | 'adhoc';
  reportingProfile: string;
  irDomains: string[];
  nseSymbol: string | null;
  bseCode: string | null;
};

/** `watchlist: true` restricts to companies on the user's watchlist (see ensureWatchlist). */
export function listCompanies(db: Db, opts: { role?: 'portfolio' | 'research'; ids?: string[]; watchlist?: boolean } = {}): CompanyRow[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.role, c.reporting_profile, c.ir_domains,
         (SELECT symbol FROM listing WHERE company_id = c.id AND exchange = 'NSE') AS nse,
         (SELECT symbol FROM listing WHERE company_id = c.id AND exchange = 'BSE') AS bse
       FROM company c WHERE (@role IS NULL OR c.role = @role)
         AND (@wl = 0 OR c.id IN (SELECT company_id FROM watchlist_entry)) ORDER BY c.name`,
    )
    .all({ role: opts.role ?? null, wl: opts.watchlist ? 1 : 0 }) as { id: string; name: string; role: CompanyRow['role']; reporting_profile: string; ir_domains: string; nse: string | null; bse: string | null }[];
  return rows
    .filter((r) => !opts.ids || opts.ids.includes(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      reportingProfile: r.reporting_profile,
      irDomains: JSON.parse(r.ir_domains) as string[],
      nseSymbol: r.nse,
      bseCode: r.bse,
    }));
}

export function listListings(db: Db, opts: { role?: 'portfolio' | 'research'; exchange?: Exchange; watchlist?: boolean } = {}): ListingRow[] {
  return db
    .prepare(
      `SELECT l.id, l.company_id, l.exchange, l.symbol, l.provider_symbol, l.resolution_status
       FROM listing l JOIN company c ON c.id = l.company_id
       WHERE (@role IS NULL OR c.role = @role) AND (@exchange IS NULL OR l.exchange = @exchange)
         AND (@wl = 0 OR c.id IN (SELECT company_id FROM watchlist_entry))
       ORDER BY c.name, l.exchange DESC`,
    )
    .all({ role: opts.role ?? null, exchange: opts.exchange ?? null, wl: opts.watchlist ? 1 : 0 }) as ListingRow[];
}

export function getCompany(db: Db, id: string): CompanyRow | null {
  return listCompanies(db, { ids: [id] })[0] ?? null;
}

// ------------------------------------------------------------ watchlist and preferences
// One local user: there are no accounts, so these are shared by anyone using this server.

const WATCHLIST_SEEDED = 'watchlist.seeded';

/**
 * Seeds the watchlist from the configured portfolio once, the first time any
 * portfolio company exists. After that the stored watchlist is authoritative,
 * including when the user empties it.
 */
export function ensureWatchlist(db: Db, now: string): void {
  if (getPreference(db, WATCHLIST_SEEDED) !== null) return;
  const portfolio = listCompanies(db, { role: 'portfolio' });
  if (portfolio.length === 0) return;
  db.transaction(() => {
    const ins = db.prepare(`INSERT OR IGNORE INTO watchlist_entry (company_id, added_at) VALUES (?, ?)`);
    for (const c of portfolio) ins.run(c.id, now);
    setPreference(db, WATCHLIST_SEEDED, now, now);
  })();
}

export function watchlistIds(db: Db): string[] {
  return (db.prepare(`SELECT company_id FROM watchlist_entry ORDER BY company_id`).all() as { company_id: string }[]).map((r) => r.company_id);
}

/** Adds a known company; returns false when no such company exists. */
export function addToWatchlist(db: Db, companyId: string, now: string): boolean {
  if (!getCompany(db, companyId)) return false;
  db.prepare(`INSERT OR IGNORE INTO watchlist_entry (company_id, added_at) VALUES (?, ?)`).run(companyId, now);
  return true;
}

export function removeFromWatchlist(db: Db, companyId: string): boolean {
  return db.prepare(`DELETE FROM watchlist_entry WHERE company_id = ?`).run(companyId).changes > 0;
}

export function getPreference(db: Db, key: string): string | null {
  const row = db.prepare(`SELECT value FROM preference WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setPreference(db: Db, key: string, value: string, now: string): void {
  db.prepare(`INSERT INTO preference (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now);
}

export function setListingResolution(db: Db, id: string, status: 'resolved' | 'unresolved', note: string | null, now: string): void {
  db.prepare(`UPDATE listing SET resolution_status = ?, resolution_note = ?, resolution_checked_at = ? WHERE id = ?`).run(status, note, now, id);
}

// ------------------------------------------------------------ fetch provenance

export type FetchStatus = 'ok' | 'partial' | 'unavailable' | 'invalid_payload';

export function startFetch(db: Db, input: { provider: string; dataMode: 'live' | 'fixture'; requestKey: string; now: string }): string {
  const id = newId();
  db.prepare(`INSERT INTO source_fetch (id, provider, data_mode, request_key, started_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    input.provider,
    input.dataMode,
    input.requestKey,
    input.now,
  );
  return id;
}

export function finishFetch(
  db: Db,
  id: string,
  r: { status: FetchStatus; httpStatus?: number | null; itemCount?: number; rejectedCount?: number; error?: string | null; now: string },
): void {
  db.prepare(
    `UPDATE source_fetch SET finished_at = ?, status = ?, http_status = ?, item_count = ?, rejected_count = ?, error_message = ? WHERE id = ?`,
  ).run(r.now, r.status, r.httpStatus ?? null, r.itemCount ?? 0, r.rejectedCount ?? 0, r.error ? r.error.slice(0, 500) : null, id);
}

export type FetchRow = { id: string; provider: string; data_mode: 'live' | 'fixture'; request_key: string; started_at: string; finished_at: string | null; status: FetchStatus | null; error_message: string | null };

export function lastFetch(db: Db, requestKey: string): FetchRow | null {
  return (db.prepare(`SELECT * FROM source_fetch WHERE request_key = ? ORDER BY started_at DESC LIMIT 1`).get(requestKey) as FetchRow | undefined) ?? null;
}

// ------------------------------------------------------------ prices

export type UpsertBarsResult = { inserted: number; updated: number; unchanged: number };

/**
 * Idempotent on (listing, trade_date): re-ingesting the same session never
 * duplicates it. A provider revision (e.g. a corrected volume) updates the row
 * and its last_ingested_at; first_ingested_at is preserved.
 */
export function upsertBars(db: Db, listingIdValue: string, bars: PriceBar[], fetchId: string, now: string): UpsertBarsResult {
  const select = db.prepare(`SELECT open, high, low, close, adj_close, volume FROM price_bar WHERE listing_id = ? AND trade_date = ?`);
  const insert = db.prepare(
    `INSERT INTO price_bar (listing_id, trade_date, open, high, low, close, adj_close, volume, source_fetch_id, first_ingested_at, last_ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE price_bar SET open = ?, high = ?, low = ?, close = ?, adj_close = ?, volume = ?, source_fetch_id = ?, last_ingested_at = ?
     WHERE listing_id = ? AND trade_date = ?`,
  );
  const result: UpsertBarsResult = { inserted: 0, updated: 0, unchanged: 0 };
  db.transaction(() => {
    for (const b of bars) {
      const existing = select.get(listingIdValue, b.tradeDate) as
        | { open: number; high: number; low: number; close: number; adj_close: number | null; volume: number }
        | undefined;
      if (!existing) {
        insert.run(listingIdValue, b.tradeDate, b.open, b.high, b.low, b.close, b.adjClose, b.volume, fetchId, now, now);
        result.inserted += 1;
      } else if (
        existing.open !== b.open ||
        existing.high !== b.high ||
        existing.low !== b.low ||
        existing.close !== b.close ||
        existing.adj_close !== b.adjClose ||
        existing.volume !== b.volume
      ) {
        update.run(b.open, b.high, b.low, b.close, b.adjClose, b.volume, fetchId, now, listingIdValue, b.tradeDate);
        result.updated += 1;
      } else {
        result.unchanged += 1;
      }
    }
  })();
  return result;
}

export type StoredBar = PriceBar & { firstIngestedAt: string; lastIngestedAt: string };

export function getBars(db: Db, listingIdValue: string, opts: { from?: string; limit?: number } = {}): StoredBar[] {
  const rows = db
    .prepare(
      `SELECT trade_date, open, high, low, close, adj_close, volume, first_ingested_at, last_ingested_at FROM price_bar
       WHERE listing_id = ? AND trade_date >= ? ORDER BY trade_date DESC LIMIT ?`,
    )
    .all(listingIdValue, opts.from ?? '0000-00-00', opts.limit ?? 10_000) as {
    trade_date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    adj_close: number | null;
    volume: number;
    first_ingested_at: string;
    last_ingested_at: string;
  }[];
  return rows
    .map((r) => ({
      tradeDate: r.trade_date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      adjClose: r.adj_close,
      volume: r.volume,
      firstIngestedAt: r.first_ingested_at,
      lastIngestedAt: r.last_ingested_at,
    }))
    .reverse();
}

export function latestTradeDate(db: Db, listingIdValue: string): string | null {
  const row = db.prepare(`SELECT MAX(trade_date) AS d FROM price_bar WHERE listing_id = ?`).get(listingIdValue) as { d: string | null };
  return row.d;
}

// ------------------------------------------------------------ announcements

export type InsertAnnouncementResult = { status: 'inserted'; id: string } | { status: 'duplicate'; id: string };

/** Inserts an announcement unless its dedupe key (exchange ref, or conservative fallback) already exists. */
export function insertAnnouncement(db: Db, a: AnnouncementInput, meta: { provider: string; fetchId: string; now: string }): InsertAnnouncementResult {
  const dedupeKey = announcementDedupeKey(a);
  const existing = db
    .prepare(`SELECT id FROM announcement WHERE dedupe_key = ? OR (exchange = ? AND exchange_ref IS NOT NULL AND exchange_ref = ?)`)
    .get(dedupeKey, a.exchange, a.exchangeRef) as { id: string } | undefined;
  if (existing) return { status: 'duplicate', id: existing.id };
  const id = newId();
  db.prepare(
    `INSERT INTO announcement (id, company_id, exchange, exchange_ref, dedupe_key, title, published_at, published_at_raw, source_url, document_url, source_provider, source_fetch_id, ingested_at)
     VALUES (@id, @companyId, @exchange, @exchangeRef, @dedupeKey, @title, @publishedAt, @publishedAtRaw, @sourceUrl, @documentUrl, @provider, @fetchId, @now)`,
  ).run({ ...a, id, dedupeKey, provider: meta.provider, fetchId: meta.fetchId, now: meta.now });
  return { status: 'inserted', id };
}

/** Stores a classification next to (never over) the announcement; one row per classifier version. */
export function saveClassification(db: Db, announcementId: string, c: Classification, now: string): void {
  db.prepare(
    `INSERT INTO announcement_classification (announcement_id, version, category, status, secondary, rule_ids, method, classified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(announcement_id, version) DO UPDATE SET category = excluded.category, status = excluded.status,
       secondary = excluded.secondary, rule_ids = excluded.rule_ids, classified_at = excluded.classified_at`,
  ).run(announcementId, c.version, c.category, c.status, JSON.stringify(c.secondary), JSON.stringify(c.ruleIds), c.method, now);
}

export type AnnouncementRow = {
  id: string;
  company_id: string;
  exchange: Exchange;
  exchange_ref: string | null;
  title: string;
  published_at: string;
  published_at_raw: string;
  source_url: string;
  document_url: string | null;
  source_provider: string;
  ingested_at: string;
  category: string | null;
  classification_status: string | null;
};

export function listAnnouncements(db: Db, window: { from: string; to: string; companyId?: string }): AnnouncementRow[] {
  return db
    .prepare(
      `SELECT a.*, c.category, c.status AS classification_status
       FROM announcement a
       LEFT JOIN announcement_classification c ON c.announcement_id = a.id
         AND c.version = (SELECT version FROM announcement_classification WHERE announcement_id = a.id ORDER BY classified_at DESC LIMIT 1)
       WHERE a.published_at >= @from AND a.published_at < @to AND (@companyId IS NULL OR a.company_id = @companyId)
       ORDER BY a.published_at DESC`,
    )
    .all({ from: window.from, to: window.to, companyId: window.companyId ?? null }) as AnnouncementRow[];
}

// ------------------------------------------------------------ documents

export type { DocumentKind, DocumentOrigin };
export type DocumentAvailability = 'pending' | 'fetched' | 'failed' | 'unavailable' | 'too_large' | 'unsupported_type' | 'not_fetched_policy';

export type DocumentInput = {
  companyId: string;
  kind: DocumentKind;
  title: string;
  periodLabel: string | null;
  publishedAt: string | null;
  sourceUrl: string;
  discoveredVia: string;
  origin: DocumentOrigin;
};

export type DocumentRow = {
  id: string;
  company_id: string;
  kind: DocumentKind;
  title: string;
  period_label: string | null;
  published_at: string | null;
  source_url: string;
  discovered_via: string;
  origin: DocumentOrigin;
  availability: DocumentAvailability;
  last_error: string | null;
  duplicate_of: string | null;
};

/** Registers a document by its source URL. Returns the existing id when the URL is already known. */
export function registerDocument(db: Db, d: DocumentInput, now: string): { id: string; created: boolean } {
  const existing = db.prepare(`SELECT id FROM document WHERE source_url = ?`).get(d.sourceUrl) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };
  const id = newId();
  // Only primary sources are queued for download; others are recorded but never fetched.
  const availability: DocumentAvailability = isPrimarySource(d.origin) ? 'pending' : 'not_fetched_policy';
  db.prepare(
    `INSERT INTO document (id, company_id, kind, title, period_label, published_at, source_url, discovered_via, origin, availability, created_at, updated_at)
     VALUES (@id, @companyId, @kind, @title, @periodLabel, @publishedAt, @sourceUrl, @discoveredVia, @origin, @availability, @now, @now)`,
  ).run({ ...d, id, availability, now });
  return { id, created: true };
}

export function getDocument(db: Db, id: string): DocumentRow | null {
  return (db.prepare(`SELECT * FROM document WHERE id = ?`).get(id) as DocumentRow | undefined) ?? null;
}

export function listDocuments(db: Db, opts: { companyId?: string; availability?: DocumentAvailability } = {}): DocumentRow[] {
  return db
    .prepare(
      `SELECT * FROM document WHERE (@companyId IS NULL OR company_id = @companyId) AND (@availability IS NULL OR availability = @availability)
       ORDER BY published_at DESC, title`,
    )
    .all({ companyId: opts.companyId ?? null, availability: opts.availability ?? null }) as DocumentRow[];
}

export function setDocumentAvailability(db: Db, id: string, availability: DocumentAvailability, error: string | null, now: string): void {
  db.prepare(`UPDATE document SET availability = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(availability, error ? error.slice(0, 500) : null, now, id);
}

export type VersionInput = {
  documentId: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  finalUrl: string;
  blobPath: string;
  fetchedAt: string;
};

/**
 * Records a fetched version. Same document + same hash → existing version
 * (no duplicate). If another document already has these exact bytes, this
 * document is marked as its duplicate (conservative cross-URL dedupe).
 */
export function recordVersion(db: Db, v: VersionInput): { versionId: string; created: boolean; duplicateOf: string | null } {
  return db.transaction(() => {
    const same = db.prepare(`SELECT id FROM document_version WHERE document_id = ? AND content_sha256 = ?`).get(v.documentId, v.sha256) as
      | { id: string }
      | undefined;
    if (same) return { versionId: same.id, created: false, duplicateOf: null };
    const other = db
      .prepare(`SELECT document_id FROM document_version WHERE content_sha256 = ? AND document_id <> ? ORDER BY fetched_at LIMIT 1`)
      .get(v.sha256, v.documentId) as { document_id: string } | undefined;
    const versionId = newId();
    db.prepare(
      `INSERT INTO document_version (id, document_id, content_sha256, byte_size, mime_type, final_url, fetched_at, blob_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(versionId, v.documentId, v.sha256, v.byteSize, v.mimeType, v.finalUrl, v.fetchedAt, v.blobPath);
    if (other) db.prepare(`UPDATE document SET duplicate_of = ? WHERE id = ?`).run(other.document_id, v.documentId);
    return { versionId, created: true, duplicateOf: other?.document_id ?? null };
  })();
}

export type Segment = { pageNumber: number | null; sectionHeading: string | null; locationLabel: string; text: string };

export type ExtractionOutcome =
  | { status: 'extracted' | 'partial'; segments: Segment[]; pageCount: number | null; extractorVersion: string; note?: string }
  | { status: 'no_text_layer' | 'failed'; error: string; pageCount: number | null; extractorVersion: string };

/** Stores extracted content separately from document metadata; replaces any earlier extraction of this version. */
export function saveExtraction(db: Db, versionId: string, outcome: ExtractionOutcome): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM document_segment WHERE version_id = ?`).run(versionId);
    if (outcome.status === 'extracted' || outcome.status === 'partial') {
      const insert = db.prepare(
        `INSERT INTO document_segment (version_id, ordinal, page_number, section_heading, location_label, text) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      outcome.segments.forEach((s, i) => insert.run(versionId, i, s.pageNumber, s.sectionHeading, s.locationLabel, s.text));
    }
    const message = 'error' in outcome ? outcome.error : (outcome.note ?? null);
    db.prepare(`UPDATE document_version SET extraction_status = ?, extraction_error = ?, extractor_version = ?, page_count = ? WHERE id = ?`).run(
      outcome.status,
      message,
      outcome.extractorVersion,
      outcome.pageCount,
      versionId,
    );
  })();
}

export function getSegments(db: Db, versionId: string): Segment[] {
  return (
    db
      .prepare(`SELECT page_number, section_heading, location_label, text FROM document_segment WHERE version_id = ? ORDER BY ordinal`)
      .all(versionId) as { page_number: number | null; section_heading: string | null; location_label: string; text: string }[]
  ).map((r) => ({ pageNumber: r.page_number, sectionHeading: r.section_heading, locationLabel: r.location_label, text: r.text }));
}

export type VersionRow = {
  id: string;
  document_id: string;
  content_sha256: string;
  byte_size: number;
  extraction_status: 'pending' | 'extracted' | 'partial' | 'no_text_layer' | 'failed';
  extraction_error: string | null;
  page_count: number | null;
  fetched_at: string;
  blob_path: string;
};

export function latestVersion(db: Db, documentId: string): VersionRow | null {
  return (
    (db.prepare(`SELECT * FROM document_version WHERE document_id = ? ORDER BY fetched_at DESC LIMIT 1`).get(documentId) as VersionRow | undefined) ?? null
  );
}

// ------------------------------------------------------------ financial facts

/** Validates and stores a fact. Throws on invalid facts; the database CHECKs are a second line of defence. */
export function insertFact(db: Db, input: FinancialFact): string {
  const f = FinancialFactSchema.parse(input);
  const id = newId();
  db.prepare(
    `INSERT INTO financial_fact (id, company_id, metric, basis, period_type, period_start, period_end, period_label, status, value,
       reported_text, reported_value, unit, reported_scale, currency, source_document_id, source_location, extraction_method,
       extractor_version, verification_status, verification_note, restated, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    f.companyId,
    f.metric,
    f.basis,
    f.period.type,
    f.period.start,
    f.period.end,
    f.period.label,
    f.status,
    f.value,
    f.reportedText,
    f.reportedValue,
    f.unit,
    f.reportedScale,
    f.currency,
    f.sourceDocumentId,
    JSON.stringify(f.sourceLocation),
    f.extractionMethod,
    f.extractorVersion,
    f.verificationStatus,
    f.verificationNote,
    f.restated ? 1 : 0,
    f.ingestedAt,
  );
  return id;
}

type FactRow = {
  company_id: string;
  metric: string;
  basis: StatementBasis;
  period_type: Period['type'];
  period_start: string;
  period_end: string;
  period_label: string;
  status: FinancialFact['status'];
  value: number | null;
  reported_text: string | null;
  reported_value: number | null;
  unit: FinancialFact['unit'];
  reported_scale: FinancialFact['reportedScale'];
  currency: string | null;
  source_document_id: string;
  source_location: string;
  extraction_method: FinancialFact['extractionMethod'];
  extractor_version: string;
  verification_status: FinancialFact['verificationStatus'];
  verification_note: string | null;
  restated: number;
  ingested_at: string;
};

/** All sources for one key. Basis and period are part of the key, so bases are never merged here. */
export function factsFor(db: Db, key: { companyId: string; metric: string; basis: StatementBasis; period: Pick<Period, 'type' | 'end'> }): FinancialFact[] {
  const rows = db
    .prepare(`SELECT * FROM financial_fact WHERE company_id = ? AND metric = ? AND basis = ? AND period_type = ? AND period_end = ? ORDER BY ingested_at`)
    .all(key.companyId, key.metric, key.basis, key.period.type, key.period.end) as FactRow[];
  return rows.map((r) => rowToFact(r));
}

/** All facts for a company (every basis and period). Rows are re-validated on the way out. */
export function factsForCompany(db: Db, companyId: string): FinancialFact[] {
  const rows = db.prepare(`SELECT * FROM financial_fact WHERE company_id = ? ORDER BY period_end DESC, ingested_at`).all(companyId) as FactRow[];
  return rows.map((r) => rowToFact(r));
}

/** Removes a document's facts before re-extraction, so re-runs never duplicate or leave stale figures. */
export function deleteFactsForDocument(db: Db, documentId: string): void {
  db.prepare(`DELETE FROM financial_fact WHERE source_document_id = ?`).run(documentId);
}

function rowToFact(r: FactRow): FinancialFact {
  return FinancialFactSchema.parse({
    companyId: r.company_id,
    metric: r.metric,
    basis: r.basis,
    period: { type: r.period_type, start: r.period_start, end: r.period_end, label: r.period_label },
    status: r.status,
    value: r.value,
    reportedText: r.reported_text,
    reportedValue: r.reported_value,
    unit: r.unit,
    reportedScale: r.reported_scale,
    currency: r.currency,
    sourceDocumentId: r.source_document_id,
    sourceLocation: JSON.parse(r.source_location) as unknown,
    extractionMethod: r.extraction_method,
    extractorVersion: r.extractor_version,
    verificationStatus: r.verification_status,
    verificationNote: r.verification_note,
    restated: r.restated === 1,
    ingestedAt: r.ingested_at,
  });
}

export type PageText = { pageNumber: number; text: string };

export function pagesOfVersion(db: Db, versionId: string): PageText[] {
  return db
    .prepare(`SELECT page_number AS pageNumber, text FROM document_segment WHERE version_id = ? AND page_number IS NOT NULL ORDER BY ordinal`)
    .all(versionId) as PageText[];
}
