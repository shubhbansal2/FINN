// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { Db } from '@/db/connection';
import { factsForDocument, insertAnnouncement, recordVersion, registerDocument, saveClassification, saveExtraction, setDocumentAvailability, startFetch } from '@/db/repositories';
import { periodEnding, reportedCurrencyFact, type FinancialFact, type Period } from '@/domain/facts';
import { classifyAnnouncement } from '@/domain/taxonomy';
import { ingestResultsFilings } from '@/ingest/results';
import { fakeHttp, seededDb, T0 } from '@/test/helpers';

import { buildFirstCut, change, UNCHECKED } from './first-cut';
import { getDigest } from './service';
import type { Change, ResultsFirstCut } from './types';

/** A consolidated results page in the Reg. 33 layout: Q2 FY27, Q1 FY27, Q2 FY26, H1 FY27, H1 FY26 (₹ crore). */
const RESULTS_PAGE = `Specimen Industries Limited
UNAUDITED CONSOLIDATED FINANCIAL RESULTS FOR THE QUARTER / HALF YEAR ENDED 30TH SEPTEMBER, 2026
(₹ in crore)
Particulars Quarter Ended Half Year Ended
Revenue from Operations 1,240 1,180 1,050 2,420 2,050
Other Income 12 11 10 23 20
Finance Costs 18 17 16 35 32
Depreciation and Amortisation Expense 54 47 33 101 66
Profit Before Tax 176 165 150 341 300
Current Tax 30 28 25 58 50
Deferred Tax 15 13 13 28 26
Profit After Tax 131 124 112 255 224`;

const CRORE = 10_000_000;
const ratio = (c: Change) => (c.kind === 'ratio' ? c.value : c.kind);
const line = (cut: ResultsFirstCut | null, metric: string) => cut?.lines.find((l) => l.metric === metric);

function seedResultsFiling(db: Db, opts: { title: string; pages: string[]; url: string; availability?: 'fetched' | 'pending' }) {
  const fetchId = startFetch(db, { provider: 'test', dataMode: 'live', requestKey: 'k', now: T0 });
  const ann = insertAnnouncement(
    db,
    { companyId: 'nse:specimen', exchange: 'BSE', exchangeRef: null, title: opts.title, publishedAt: '2026-10-30T12:00:00.000Z', publishedAtRaw: '30 Oct', sourceUrl: 'https://www.screener.in/company/SPECIMEN/', documentUrl: opts.url },
    { provider: 'test', fetchId, now: T0 },
  );
  saveClassification(db, ann.id, classifyAnnouncement(opts.title), T0);
  const doc = registerDocument(
    db,
    { companyId: 'nse:specimen', kind: 'quarterly_results', title: opts.title, periodLabel: null, publishedAt: '2026-10-30T12:00:00.000Z', sourceUrl: opts.url, discoveredVia: 'screener:announcement', origin: 'exchange_filed' },
    T0,
  );
  if (opts.availability !== 'pending') {
    const v = recordVersion(db, { documentId: doc.id, sha256: doc.id.padEnd(64, '0').slice(0, 64), byteSize: 100, mimeType: 'application/pdf', finalUrl: opts.url, blobPath: 'x', fetchedAt: T0 });
    saveExtraction(db, v.versionId, { status: 'extracted', segments: opts.pages.map((text, i) => ({ pageNumber: i + 1, sectionHeading: null, locationLabel: `p. ${i + 1}`, text })), pageCount: opts.pages.length, extractorVersion: 'test' });
    setDocumentAvailability(db, doc.id, 'fetched', null, T0);
  }
  return doc.id;
}

const ingest = (db: Db, http?: ReturnType<typeof fakeHttp>) =>
  ingestResultsFilings(db, { since: '2026-09-01T00:00:00.000Z', companyIds: new Set(['nse:specimen']), blobDir: '.', now: () => new Date(T0), limit: 10, pauseMs: 0, sleep: async () => undefined, http });

describe('results first cut from a filing', () => {
  it('reads Revenue, EBITDA, PBT and PAT with QoQ and YoY from the filing’s own columns', async () => {
    const db = seededDb();
    const docId = seedResultsFiling(db, { title: 'Unaudited Financial Results for the quarter ended September 30, 2026', pages: [RESULTS_PAGE], url: 'https://www.bseindia.com/r1.pdf' });

    const [summary] = await ingest(db);
    expect(summary).toMatchObject({ outcome: 'parsed', quarterEnd: '2026-09-30' });

    const cut = buildFirstCut(factsForDocument(db, docId), (page) => `https://www.bseindia.com/r1.pdf#page=${page}`);
    expect(cut).toMatchObject({ basis: 'consolidated', quarter: { end: '2026-09-30', label: 'Q2 FY27' }, previousLabel: 'Q1 FY27', yearAgoLabel: 'Q2 FY26', page: 1 });

    // Hand-worked from the page: current, previous quarter, year-ago quarter.
    expect(line(cut, 'revenue')).toMatchObject({ current: 1240 * CRORE, previous: 1180 * CRORE, yearAgo: 1050 * CRORE, derived: false, note: null });
    expect(ratio(line(cut, 'revenue')!.qoq)).toBeCloseTo(60 / 1180, 10);
    expect(ratio(line(cut, 'revenue')!.yoy)).toBeCloseTo(190 / 1050, 10);

    // EBITDA = PBT + finance costs + D&A: 176+18+54 = 248, 165+17+47 = 229, 150+16+33 = 199.
    expect(line(cut, 'ebitda')).toMatchObject({ current: 248 * CRORE, previous: 229 * CRORE, yearAgo: 199 * CRORE, derived: true });
    expect(ratio(line(cut, 'ebitda')!.qoq)).toBeCloseTo(19 / 229, 10);
    expect(ratio(line(cut, 'ebitda')!.yoy)).toBeCloseTo(49 / 199, 10);

    expect(ratio(line(cut, 'pbt')!.yoy)).toBeCloseTo(26 / 150, 10);
    expect(line(cut, 'pat')).toMatchObject({ current: 131 * CRORE, previous: 124 * CRORE, yearAgo: 112 * CRORE });
    expect(ratio(line(cut, 'pat')!.qoq)).toBeCloseTo(7 / 124, 10);
    expect(ratio(line(cut, 'pat')!.yoy)).toBeCloseTo(19 / 112, 10);
  });

  it('puts the first cut on the results signal in the digest', async () => {
    const db = seededDb();
    seedResultsFiling(db, { title: 'Unaudited Financial Results for the quarter ended September 30, 2026', pages: [RESULTS_PAGE], url: 'https://www.bseindia.com/r1.pdf' });
    await ingest(db);

    const digest = getDigest(db, { window: '7d', now: new Date('2026-11-01T10:00:00.000Z'), dataMode: 'live' });
    if (!digest.ok) throw new Error('digest failed');
    const signal = digest.value.groups.flatMap((g) => g.items).map((i) => i.signal).find((s) => s.category === 'results');
    expect(signal?.firstCut?.quarter.label).toBe('Q2 FY27');
    expect(signal?.firstCut?.url).toContain('bseindia.com/r1.pdf');
    expect(signal?.explanation.unknowns.join(' ')).not.toContain('No headline figures');
  });

  it('leaves a board-meeting intimation without figures, and reports a failed download', async () => {
    const db = seededDb();
    seedResultsFiling(db, { title: 'Board Meeting Intimation for Financial Results', pages: ['The Board will meet on 30 October 2026 to consider the results.'], url: 'https://www.bseindia.com/intimation.pdf' });
    seedResultsFiling(db, { title: 'Financial Results for Q2 FY27', pages: [], url: 'https://www.bseindia.com/missing.pdf', availability: 'pending' });

    const out = await ingest(db, fakeHttp({}));
    expect(out.map((r) => r.outcome).sort()).toEqual(['download_failed', 'no_figures']);
  });
});

describe('first cut arithmetic', () => {
  const Q = (end: string) => (periodEnding('quarter', end) as { ok: true; value: Period }).value;
  const fact = (metric: string, printed: string, end: string, status: FinancialFact['verificationStatus'] = 'checks_passed') =>
    reportedCurrencyFact({ companyId: 'nse:specimen', metric, basis: 'standalone', period: Q(end), printed, scale: 'crore', sourceDocumentId: 'doc', sourceLocation: { page: 3 }, extractionMethod: 'rule_parser', extractorVersion: 'test', verificationStatus: status, ingestedAt: T0 });

  it('does not compute growth from a zero or negative base, and says what is missing', () => {
    const cut = buildFirstCut(
      [fact('revenue_from_operations', '500', '2026-09-30'), fact('revenue_from_operations', '400', '2026-06-30'), fact('profit_after_tax', '20', '2026-09-30'), fact('profit_after_tax', '(15)', '2025-09-30')],
      () => null,
    );
    expect(cut?.basis).toBe('standalone');
    expect(ratio(line(cut, 'revenue')!.qoq)).toBeCloseTo(0.25, 10);
    expect(line(cut, 'revenue')!.yoy).toEqual({ kind: 'missing' });
    expect(line(cut, 'pat')!.yoy).toEqual({ kind: 'not_meaningful' });
    expect(line(cut, 'ebitda')).toMatchObject({ current: null, note: expect.stringContaining('not available') });
  });

  it('leaves out figures that were not checked, and returns nothing when no checked figure remains', () => {
    const mixed = buildFirstCut([fact('revenue_from_operations', '500', '2026-09-30'), fact('profit_after_tax', '40', '2026-09-30', 'unverified')], () => null);
    expect(line(mixed, 'revenue')?.current).toBe(500 * CRORE);
    expect(line(mixed, 'pat')).toMatchObject({ current: null, note: UNCHECKED });
    expect(buildFirstCut([fact('revenue_from_operations', '500', '2026-09-30', 'unverified')], () => null)).toBeNull();
    expect(buildFirstCut([], () => null)).toBeNull();
    expect(change(10, 0)).toEqual({ kind: 'not_meaningful' });
  });
});
