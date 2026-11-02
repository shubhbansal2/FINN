// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { FilingsAdapter, FilingsResult, ListedAnnouncement } from '@/data/filings/types';
import type { PriceAdapter, PriceFetchResult } from '@/data/prices/yahoo';
import {
  factsFor,
  getBars,
  getDocument,
  getSegments,
  insertFact,
  latestVersion,
  listAnnouncements,
  listCompanies,
  listListings,
  registerDocument,
} from '@/db/repositories';
import { periodEnding, reportedCurrencyFact, resolveFact, type Period } from '@/domain/facts';
import { fakeHttp, makePdf, seededDb, T0, tempDir } from '@/test/helpers';

import { processDocument } from './documents';
import { ingestFilings } from './filings';
import { ingestPrices } from './prices';

const clock = (iso = T0) => () => new Date(iso);

function priceAdapter(results: PriceFetchResult[]): PriceAdapter {
  let i = 0;
  return {
    provider: 'test',
    dataMode: 'fixture',
    fetchDaily: async () => results[Math.min(i++, results.length - 1)] as PriceFetchResult,
  };
}

const bar = (tradeDate: string, close = 104, volume = 1000) => ({ tradeDate, open: 100, high: 105, low: 99, close, adjClose: close, volume });
const ok = (bars: ReturnType<typeof bar>[]): PriceFetchResult => ({ status: 'ok', bars, rejected: [], httpStatus: 200, fetchedAt: T0 });

describe('ingestPrices', () => {
  it('never duplicates an observation and keeps first ingestion time on revision', async () => {
    const db = seededDb();
    const nse = listListings(db, { exchange: 'NSE' });
    const adapter = priceAdapter([ok([bar('2026-10-29'), bar('2026-10-30')]), ok([bar('2026-10-29'), bar('2026-10-30', 104, 1500)])]);

    const first = await ingestPrices(db, adapter, nse, { now: clock('2026-10-30T12:00:00Z') });
    const second = await ingestPrices(db, adapter, nse, { now: clock('2026-10-31T12:00:00Z') });

    expect(first[0]).toMatchObject({ outcome: 'stored', inserted: 2 });
    expect(second[0]).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
    const bars = getBars(db, 'NSE:SPECIMEN');
    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({ tradeDate: '2026-10-30', volume: 1500, firstIngestedAt: '2026-10-30T12:00:00.000Z', lastIngestedAt: '2026-10-31T12:00:00.000Z' });
  });

  it('stores the trade date and the ingestion time separately', async () => {
    const db = seededDb();
    await ingestPrices(db, priceAdapter([ok([bar('2026-10-30')])]), listListings(db, { exchange: 'NSE' }), { now: clock('2026-11-01T06:00:00Z') });
    expect(getBars(db, 'NSE:SPECIMEN')[0]).toMatchObject({ tradeDate: '2026-10-30', firstIngestedAt: '2026-11-01T06:00:00.000Z' });
  });

  it('marks an unresolved ticker and stores nothing for it', async () => {
    const db = seededDb();
    const r = await ingestPrices(
      db,
      priceAdapter([{ status: 'unavailable', reason: 'unresolved_symbol', httpStatus: 404, message: 'Not Found', fetchedAt: T0 }]),
      listListings(db, { exchange: 'NSE' }),
      { now: clock() },
    );
    expect(r[0]?.outcome).toBe('unresolved');
    expect(listListings(db, { exchange: 'NSE' })[0]?.resolution_status).toBe('unresolved');
    expect(getBars(db, 'NSE:SPECIMEN')).toHaveLength(0);
  });

  it('records malformed provider responses without storing data', async () => {
    const db = seededDb();
    const r = await ingestPrices(db, priceAdapter([{ status: 'invalid_payload', message: 'bad', httpStatus: 200, fetchedAt: T0 }]), listListings(db, { exchange: 'NSE' }), { now: clock() });
    expect(r[0]?.outcome).toBe('invalid_payload');
    expect(db.prepare(`SELECT status, error_message FROM source_fetch`).get()).toEqual({ status: 'invalid_payload', error_message: 'bad' });
  });

  it('is enforced by the database too: one row per listing and date', () => {
    const db = seededDb();
    db.prepare(`INSERT INTO source_fetch (id, provider, data_mode, request_key, started_at) VALUES ('f', 'p', 'live', 'k', ?)`).run(T0);
    const insert = db.prepare(
      `INSERT INTO price_bar (listing_id, trade_date, open, high, low, close, volume, source_fetch_id, first_ingested_at, last_ingested_at) VALUES ('NSE:SPECIMEN', '2026-10-30', 1, 1, 1, 1, 1, 'f', ?, ?)`,
    );
    insert.run(T0, T0);
    expect(() => insert.run(T0, T0)).toThrow(/UNIQUE|PRIMARY KEY/);
  });
});

function filingsAdapter(results: FilingsResult[]): FilingsAdapter {
  let i = 0;
  return { provider: 'test', dataMode: 'fixture', fetchCompany: async () => results[Math.min(i++, results.length - 1)] as FilingsResult };
}

const PAGE = 'https://www.screener.in/company/SPECIMEN/consolidated/';
const listed = (over: Partial<ListedAnnouncement> = {}): ListedAnnouncement => ({
  exchange: 'BSE',
  exchangeRef: '880087f6-7ecc-40a9-8cac-de48d4616b25',
  title: 'Unaudited Financial Results For The Quarter Ended September 30, 2026.',
  publishedAt: '2026-10-30T14:12:49.000Z',
  publishedAtRaw: '2026-10-30T19:42:49+05:30',
  url: 'https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=880087f6-7ecc-40a9-8cac-de48d4616b25.pdf',
  ...over,
});
const page = (announcements: ListedAnnouncement[], documents: Extract<FilingsResult, { announcements: unknown }>['documents'] = []): FilingsResult => ({
  status: 'ok',
  pageUrl: PAGE,
  fetchedAt: T0,
  announcements,
  documents,
  warnings: [],
});

describe('ingestFilings', () => {
  const window = { from: '2026-10-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };

  it('deduplicates by exchange reference across runs and URL forms', async () => {
    const db = seededDb();
    const sameFilingOtherUrl = listed({ url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/880087f6-7ecc-40a9-8cac-de48d4616b25.pdf' });
    const adapter = filingsAdapter([page([listed()]), page([listed(), sameFilingOtherUrl])]);
    const companies = listCompanies(db);
    const a = await ingestFilings(db, adapter, companies, { now: clock() });
    const b = await ingestFilings(db, adapter, companies, { now: clock() });
    expect(a[0]).toMatchObject({ announcementsInserted: 1, announcementsDuplicate: 0 });
    expect(b[0]).toMatchObject({ announcementsInserted: 0, announcementsDuplicate: 2 });
    expect(listAnnouncements(db, window)).toHaveLength(1);
  });

  it('falls back conservatively when there is no exchange reference', async () => {
    const db = seededDb();
    const noRef = (o: Partial<ListedAnnouncement>) => listed({ exchangeRef: null, url: 'https://www.bseindia.com/a.pdf', ...o });
    await ingestFilings(
      db,
      filingsAdapter([
        page([
          noRef({}),
          noRef({ title: '  unaudited financial results for the quarter ended september 30, 2026. ' }), // same filing, reformatted
          noRef({ publishedAt: '2026-10-30T15:30:00.000Z' }), // different time → kept
          noRef({ title: 'Unaudited Financial Results For The Quarter Ended June 30, 2026.' }), // different title → kept
        ]),
      ]),
      listCompanies(db),
      { now: clock() },
    );
    expect(listAnnouncements(db, window)).toHaveLength(3);
  });

  it('preserves the source page, filing URL, filed title and both timestamps exactly', async () => {
    const db = seededDb();
    await ingestFilings(db, filingsAdapter([page([listed()])]), listCompanies(db), { now: clock('2026-11-01T07:00:00Z') });
    const [row] = listAnnouncements(db, window);
    expect(row).toMatchObject({
      title: 'Unaudited Financial Results For The Quarter Ended September 30, 2026.',
      source_url: PAGE,
      document_url: 'https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=880087f6-7ecc-40a9-8cac-de48d4616b25.pdf',
      published_at: '2026-10-30T14:12:49.000Z',
      published_at_raw: '2026-10-30T19:42:49+05:30',
      ingested_at: '2026-11-01T07:00:00.000Z',
      exchange: 'BSE',
      category: 'results',
    });
  });

  it('stores classification beside the announcement without rewriting its title', async () => {
    const db = seededDb();
    await ingestFilings(db, filingsAdapter([page([listed({ title: 'Announcement under Regulation 30 (LODR)-Investor Presentation', exchangeRef: 'abc' })])]), listCompanies(db), { now: clock() });
    const [row] = listAnnouncements(db, window);
    expect(row).toMatchObject({ title: 'Announcement under Regulation 30 (LODR)-Investor Presentation', category: 'unclassified', classification_status: 'ambiguous' });
  });

  it('registers documents with their origin; third-party links are recorded but never queued', async () => {
    const db = seededDb();
    await ingestFilings(
      db,
      filingsAdapter([
        page(
          [listed()],
          [
            { kind: 'annual_report', title: 'Annual Report 2026', periodLabel: 'FY26', publishedAt: null, url: 'https://www.bseindia.com/xml-data/corpfiling/AttachHis/x.pdf' },
            { kind: 'other', title: 'Credit rating rationale', periodLabel: null, publishedAt: null, url: 'https://www.icra.in/Rationale/1' },
            { kind: 'investor_presentation', title: 'Deck', periodLabel: null, publishedAt: null, url: 'https://ir.specimen.example/deck.pdf' },
            { kind: 'other', title: 'Blog', periodLabel: null, publishedAt: null, url: 'https://random-blog.example/post' },
          ],
        ),
      ]),
      listCompanies(db),
      { now: clock() },
    );
    const docs = db.prepare(`SELECT kind, origin, availability FROM document ORDER BY source_url`).all();
    expect(docs).toEqual(
      expect.arrayContaining([
        { kind: 'quarterly_results', origin: 'exchange_filed', availability: 'pending' },
        { kind: 'annual_report', origin: 'exchange_filed', availability: 'pending' },
        { kind: 'other', origin: 'third_party', availability: 'not_fetched_policy' },
        { kind: 'investor_presentation', origin: 'company_issued', availability: 'pending' },
        { kind: 'other', origin: 'unverified_external', availability: 'not_fetched_policy' },
      ]),
    );
  });

  it('leaves the feed empty when the source is unavailable', async () => {
    const db = seededDb();
    const r = await ingestFilings(db, filingsAdapter([{ status: 'unavailable', reason: 'http_error', message: 'HTTP 503', httpStatus: 503, fetchedAt: T0 }]), listCompanies(db), { now: clock() });
    expect(r[0]).toMatchObject({ outcome: 'unavailable', message: 'HTTP 503' });
    expect(listAnnouncements(db, window)).toHaveLength(0);
  });
});

describe('processDocument', () => {
  const longLine = (n: number) => `Revenue from operations for the quarter was reported on page ${n} of this filing.`;

  function register(db: ReturnType<typeof seededDb>, url: string, origin: 'exchange_filed' | 'third_party' = 'exchange_filed') {
    return registerDocument(db, { companyId: 'nse:specimen', kind: 'quarterly_results', title: 'Results', periodLabel: null, publishedAt: null, sourceUrl: url, discoveredVia: 'test', origin }, T0).id;
  }

  it('extracts PDF text with page numbers, separately from metadata', async () => {
    const db = seededDb();
    const id = register(db, 'https://www.bseindia.com/a.pdf');
    const http = fakeHttp({ 'a.pdf': { body: makePdf([longLine(1), longLine(2)]), contentType: 'application/pdf' } });
    const r = await processDocument(db, id, { blobDir: tempDir(), now: clock(), http });
    expect(r).toMatchObject({ outcome: 'extracted', pageCount: 2 });
    const version = latestVersion(db, id);
    expect(version?.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    const segments = getSegments(db, version?.id ?? '');
    expect(segments.map((s) => s.locationLabel)).toEqual(['p. 1', 'p. 2']);
    expect(segments[1]?.text).toContain('page 2');
    expect(getDocument(db, id)?.availability).toBe('fetched');
  });

  it('reports a corrupt PDF as a failed extraction, never as an empty document', async () => {
    const db = seededDb();
    const id = register(db, 'https://www.bseindia.com/bad.pdf');
    const http = fakeHttp({ 'bad.pdf': { body: Buffer.from('%PDF-1.4\nthis is not really a pdf'), contentType: 'application/pdf' } });
    const r = await processDocument(db, id, { blobDir: tempDir(), now: clock(), http });
    expect(r.outcome).toBe('extraction_failed');
    expect(r.message).toMatch(/could not be parsed/);
    const version = latestVersion(db, id);
    expect(version).toMatchObject({ extraction_status: 'failed' });
    expect(getSegments(db, version?.id ?? '')).toHaveLength(0);
  });

  it('reports a scanned (text-less) PDF as no_text_layer', async () => {
    const db = seededDb();
    const id = register(db, 'https://www.bseindia.com/scan.pdf');
    const http = fakeHttp({ 'scan.pdf': { body: makePdf(['', '', '']), contentType: 'application/pdf' } });
    const r = await processDocument(db, id, { blobDir: tempDir(), now: clock(), http });
    expect(r).toMatchObject({ outcome: 'no_text_layer', pageCount: 3 });
    expect(r.message).toMatch(/OCR is not supported/);
  });

  it('keeps HTML transcript sections as source locations', async () => {
    const db = seededDb();
    const id = register(db, 'https://www.bseindia.com/t.html');
    const html = '<html><body><script>alert(1)</script><h2>Opening remarks</h2><p>We delivered 12% growth.</p><h2>Q&amp;A</h2><p>Margins will improve.</p></body></html>';
    const http = fakeHttp({ 't.html': { body: html, contentType: 'text/html' } });
    await processDocument(db, id, { blobDir: tempDir(), now: clock(), http });
    const segments = getSegments(db, latestVersion(db, id)?.id ?? '');
    expect(segments).toEqual([
      { pageNumber: null, sectionHeading: 'Opening remarks', locationLabel: '§ Opening remarks', text: 'We delivered 12% growth.' },
      { pageNumber: null, sectionHeading: 'Q&A', locationLabel: '§ Q&A', text: 'Margins will improve.' },
    ]);
  });

  it('records retrieval errors and unsupported types on the document', async () => {
    const db = seededDb();
    const missing = register(db, 'https://www.bseindia.com/missing.pdf');
    const zip = register(db, 'https://www.bseindia.com/ar.zip');
    const http = fakeHttp({ 'missing.pdf': { status: 404, body: '' }, 'ar.zip': { body: Buffer.from('PK\u0003\u0004zipdata'), contentType: 'application/zip' } });
    await processDocument(db, missing, { blobDir: tempDir(), now: clock(), http });
    await processDocument(db, zip, { blobDir: tempDir(), now: clock(), http });
    expect(getDocument(db, missing)).toMatchObject({ availability: 'failed', last_error: 'HTTP 404' });
    expect(getDocument(db, zip)).toMatchObject({ availability: 'unsupported_type' });
  });

  it('falls back to BSE direct attachment paths when the redirector fails', async () => {
    const db = seededDb();
    const guid = '9c8c3f07-883a-476b-8fb2-8fe74078e9f5';
    const id = register(db, `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${guid}.pdf`);
    const http = fakeHttp({
      'AnnPdfOpen.aspx': new Error('fetch failed'),
      [`AttachLive/${guid}`]: { status: 404, body: '' },
      [`AttachHis/${guid}`]: { body: makePdf([longLine(1)]), contentType: 'application/pdf' },
    });
    const r = await processDocument(db, id, { blobDir: tempDir(), now: clock(), http });
    expect(r.outcome).toBe('extracted');
    expect(http.calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([expect.stringContaining(`AttachLive/${guid}.pdf`), expect.stringContaining(`AttachHis/${guid}.pdf`)]),
    );
    // Provenance keeps the URL the filing was listed under.
    expect(getDocument(db, id)?.source_url).toBe(`https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${guid}.pdf`);
  });

  it('does not fetch third-party documents', async () => {
    const db = seededDb();
    const id = register(db, 'https://www.icra.in/r.pdf', 'third_party');
    const http = fakeHttp({});
    const r = await processDocument(db, id, { blobDir: tempDir(), now: clock(), http });
    expect(r.outcome).toBe('skipped_policy');
    expect(http.calls).toHaveLength(0);
  });

  it('detects unchanged content and identical documents under different URLs', async () => {
    const db = seededDb();
    const pdf = makePdf([longLine(1)]);
    const a = register(db, 'https://www.bseindia.com/one.pdf');
    const b = register(db, 'https://www.bseindia.com/two.pdf');
    const http = fakeHttp({ 'one.pdf': { body: pdf, contentType: 'application/pdf' }, 'two.pdf': { body: pdf, contentType: 'application/pdf' } });
    const dir = tempDir();
    await processDocument(db, a, { blobDir: dir, now: clock(), http });
    expect((await processDocument(db, a, { blobDir: dir, now: clock(), http })).outcome).toBe('duplicate');
    await processDocument(db, b, { blobDir: dir, now: clock(), http });
    expect(getDocument(db, b)?.duplicate_of).toBe(a);
  });
});

describe('financial facts in storage', () => {
  const Q2 = (periodEnding('quarter', '2026-09-30') as { ok: true; value: Period }).value;

  function docId(db: ReturnType<typeof seededDb>, n: number) {
    return registerDocument(db, { companyId: 'nse:specimen', kind: 'quarterly_results', title: `R${n}`, periodLabel: 'Q2 FY27', publishedAt: null, sourceUrl: `https://www.bseindia.com/r${n}.pdf`, discoveredVia: 'test', origin: 'exchange_filed' }, T0).id;
  }

  const fact = (doc: string, printed: string, basis: 'consolidated' | 'standalone' = 'consolidated') =>
    reportedCurrencyFact({
      companyId: 'nse:specimen',
      metric: 'pat',
      basis,
      period: Q2,
      printed,
      scale: 'crore',
      sourceDocumentId: doc,
      sourceLocation: { page: 3, rowLabel: 'Profit for the period' },
      extractionMethod: 'rule_parser',
      extractorVersion: 'test',
      verificationStatus: 'unverified',
      ingestedAt: T0,
    });

  it('round-trips a fact with its printed value, scale and provenance', () => {
    const db = seededDb();
    const d = docId(db, 1);
    insertFact(db, fact(d, '131.00'));
    const [f] = factsFor(db, { companyId: 'nse:specimen', metric: 'pat', basis: 'consolidated', period: Q2 });
    expect(f).toMatchObject({ value: 1_310_000_000, reportedValue: 131, reportedText: '131.00', reportedScale: 'crore', currency: 'INR', sourceDocumentId: d, sourceLocation: { page: 3 } });
  });

  it('surfaces conflicting reported figures from two filings', () => {
    const db = seededDb();
    insertFact(db, fact(docId(db, 1), '131.00'));
    insertFact(db, fact(docId(db, 2), '138.00'));
    expect(resolveFact(factsFor(db, { companyId: 'nse:specimen', metric: 'pat', basis: 'consolidated', period: Q2 })).kind).toBe('conflict');
  });

  it('keeps consolidated and standalone apart', () => {
    const db = seededDb();
    const d = docId(db, 1);
    insertFact(db, fact(d, '131.00', 'consolidated'));
    insertFact(db, fact(d, '95.00', 'standalone'));
    const consolidated = factsFor(db, { companyId: 'nse:specimen', metric: 'pat', basis: 'consolidated', period: Q2 });
    expect(consolidated).toHaveLength(1);
    expect(resolveFact(consolidated)).toMatchObject({ kind: 'value' });
  });

  it('stores a missing value as NULL with its reason, and the database rejects a zero-filled "missing" value', () => {
    const db = seededDb();
    const d = docId(db, 1);
    insertFact(db, fact(d, '—'));
    const [f] = factsFor(db, { companyId: 'nse:specimen', metric: 'pat', basis: 'consolidated', period: Q2 });
    expect(f).toMatchObject({ status: 'not_reported', value: null });
    expect(() =>
      db
        .prepare(
          `INSERT INTO financial_fact (id, company_id, metric, basis, period_type, period_start, period_end, period_label, status, value, unit, currency, source_document_id, source_location, extraction_method, extractor_version, verification_status, ingested_at)
           VALUES ('x', 'nse:specimen', 'pat', 'consolidated', 'quarter', '2026-07-01', '2026-09-30', 'Q2 FY27', 'not_reported', 0, 'currency', 'INR', ?, '{"page":1}', 'rule_parser', 't', 'unverified', ?)`,
        )
        .run(d, T0),
    ).toThrow(/CHECK constraint/);
  });
});
