// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { Db } from '@/db/connection';
import { listCompanies, recordVersion, registerDocument, saveExtraction, type DocumentKind } from '@/db/repositories';
import { periodEnding, reportedCurrencyFact, type FinancialFact, type Period, type StatementBasis } from '@/domain/facts';
import { AnthropicLlmClient, UnconfiguredLlmClient, type LlmClient, type LlmRequest, type LlmResult, type MessagesTransport } from '@/llm/client';
import { seededDb, T0, tempDir } from '@/test/helpers';

import { chunkSegments, classifyLine } from './chunk';
import { runResearch, selectDocuments } from './engine';
import { FactsView } from './facts-view';
import { explicitHorizon, extractStatements, figuresAppearInQuote } from './guidance';
import { indexVersion, searchChunks, toFtsQuery } from './index';
import { figuresSupported, quoteInPassage } from './prompts';
import { ResearchReportSchema } from './report';
import { resolveCompany } from './resolve';
import { detectPeriodEnd, parseResultsPages, repairNumericText, repairSplitTokens, standardColumns } from './results-parser';
import { evaluateStatement } from './scorecard';

// ---------------------------------------------------------------- fixtures

/** A results page in the Reg. 33 layout, with the OCR artefacts seen in real filings. */
const RESULTS_PAGE = `Specimen Industries Limited
UNAUDITED CONSOLIDATED FINANCIAL RESULTS FOR THE QUARTER / HALF YEAR ENDED 30TH SEPTEMBER, 2026
(₹ in crore)
Particulars Quarter Ended Half Year Ended
Revenue from Operation s 1,240 1,180 1,050 2,420 2,050
Other Income 12 11 10 23 20
Finance Costs 18 17 16 35 32
Depreci ation / Amortisation and Depletion Expense 54 47 33 101 66
Profit Before Tax 176 165 150 341 300
Current Tax 30 28 25 58 50
Deferred Tax 15 13 13 28 26
Profit After Tax 131 124 112 255 224`;

// "1 6,013" is how OCR split "16,013" in a real filing; "Other Income 9 8 0 7" is genuinely ambiguous.
const STANDALONE_PAGE = `UNAUDITED STANDALONE FINANCIAL RESULTS FOR THE QUARTER ENDED 30TH SEPTEMBER, 2026
(₹ in crore)
Revenue from Operations 17,466 1 6,013 13,061
Other Income 9 8 0 7
Profit Before Tax 100 90 80
Tax Expense 25 22 20
Profit After Tax 75 68 60`;

const TRANSCRIPT_PAGES = [
  'Specimen Industries Q1 FY27 Earnings Conference Call. Asha Rao: We expect EBITDA margins in the range of 19% to 20% for FY27, with the second half stronger. We expect strong growth across our businesses going forward. Analyst: What is the outlook for margins next year? Asha Rao: No guidance.',
  'Asha Rao: Revenue growth for Q2 FY27 is expected to be around 15%. We are targeting double-digit growth over the medium term. Our new plant will reach 10 mtpa capacity by FY28.',
];

function seedDocument(db: Db, kind: DocumentKind, title: string, pages: string[], periodLabel: string | null = null, publishedAt: string | null = null) {
  const { id } = registerDocument(db, { companyId: 'nse:specimen', kind, title, periodLabel, publishedAt, sourceUrl: `https://www.bseindia.com/${encodeURIComponent(title)}.pdf`, discoveredVia: 'test', origin: 'exchange_filed' }, T0);
  const v = recordVersion(db, { documentId: id, sha256: `${id}`.padEnd(64, '0').slice(0, 64), byteSize: 100, mimeType: 'application/pdf', finalUrl: 'https://www.bseindia.com/x.pdf', blobPath: 'x', fetchedAt: T0 });
  saveExtraction(db, v.versionId, { status: 'extracted', segments: pages.map((text, i) => ({ pageNumber: i + 1, sectionHeading: null, locationLabel: `p. ${i + 1}`, text })), pageCount: pages.length, extractorVersion: 'test' });
  return { documentId: id, versionId: v.versionId };
}

const Q = (end: string, type: Period['type'] = 'quarter') => (periodEnding(type, end) as { ok: true; value: Period }).value;
function fact(metric: string, printed: string, period: Period, opts: { basis?: StatementBasis; doc?: string; page?: number; status?: FinancialFact['verificationStatus'] } = {}) {
  return reportedCurrencyFact({
    companyId: 'nse:specimen',
    metric,
    basis: opts.basis ?? 'consolidated',
    period,
    printed,
    scale: 'crore',
    sourceDocumentId: opts.doc ?? 'doc',
    sourceLocation: { page: opts.page ?? 1, rowLabel: metric },
    extractionMethod: 'rule_parser',
    extractorVersion: 'test',
    verificationStatus: opts.status ?? 'checks_passed',
    ingestedAt: T0,
  });
}

/** Scripted model: returns a fixed output per task, and records calls. */
class ScriptedLlm implements LlmClient {
  readonly configured = true;
  calls: string[] = [];
  constructor(private readonly outputs: Record<string, unknown>) {}
  describe() {
    return 'scripted';
  }
  async run<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push(req.task);
    const out = this.outputs[req.task];
    if (out === undefined) return { status: 'failed', reason: 'api_error', message: 'not scripted', model: 'scripted' };
    const parsed = req.schema.safeParse(out);
    return parsed.success ? { status: 'ok', output: parsed.data, model: 'scripted', cached: false } : { status: 'failed', reason: 'invalid_output', message: 'bad', model: 'scripted' };
  }
}

// ---------------------------------------------------------------- tickers

describe('resolveCompany', () => {
  const opts = { allowLiveVerification: true, now: () => new Date(T0) };

  it('resolves registry symbols, BSE codes and unique names', async () => {
    const db = seededDb();
    expect((await resolveCompany(db, 'specimen.ns', opts)).ok).toBe(true);
    expect((await resolveCompany(db, '999999', opts)).ok).toBe(true);
    expect((await resolveCompany(db, 'specimen ind', opts)).ok).toBe(true);
  });

  it('rejects malformed input without calling any provider', async () => {
    const db = seededDb();
    let called = false;
    const r = await resolveCompany(db, 'DROP TABLE;', { ...opts, verify: async () => ((called = true), { status: 'verified', name: 'x' }) });
    expect(r).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(called).toBe(false);
  });

  it('reports an unsupported ticker as not found', async () => {
    const db = seededDb();
    const r = await resolveCompany(db, 'NOSUCHCO', { ...opts, verify: async () => ({ status: 'not_found', message: 'no listing' }) });
    expect(r).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(listCompanies(db).some((c) => c.nseSymbol === 'NOSUCHCO')).toBe(false);
  });

  it('asks for clarification when a name matches several companies', async () => {
    const db = seededDb();
    const { upsertCompany } = await import('@/db/repositories');
    upsertCompany(db, { id: 'nse:specimen2', name: 'Specimen Industries Holdings', sector: 'x', size: 'mid', reportingProfile: 'industrial', irDomains: [], listings: [{ exchange: 'NSE', symbol: 'SPECIMEN2' }], role: 'research' }, T0);
    const r = await resolveCompany(db, 'specimen industries', opts);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'ambiguous') expect(r.error.candidates.map((c) => c.nseSymbol).sort()).toEqual(['SPECIMEN', 'SPECIMEN2']);
  });

  it('does not verify unknown symbols in demo mode', async () => {
    const r = await resolveCompany(seededDb(), 'NEWCO', { ...opts, allowLiveVerification: false });
    expect(r).toMatchObject({ ok: false, error: { kind: 'unverifiable' } });
  });

  it('registers a live-verified symbol as an ad-hoc company with unknown attributes, not invented ones', async () => {
    const db = seededDb();
    const r = await resolveCompany(db, 'NEWCO', { ...opts, verify: async () => ({ status: 'verified', name: 'New Co Ltd' }) });
    expect(r.ok && r.value).toMatchObject({ name: 'New Co Ltd', role: 'adhoc', reportingProfile: 'unknown' });
  });
});

// ---------------------------------------------------------------- results parser

describe('results parser', () => {
  const ctx = { companyId: 'nse:specimen', documentId: 'doc', ingestedAt: T0 };

  it('reads the reporting period despite OCR noise and maps the standard columns', () => {
    expect(detectPeriodEnd('RESULTS FOR THE QUARTER ENDED JQTH SEPTEMBER, 2026')).toBe('2026-09-30');
    expect(standardColumns('2026-09-30').map((p) => p?.label)).toEqual(['Q2 FY27', 'Q1 FY27', 'Q2 FY26', 'H1 FY27', 'H1 FY26', 'FY26']);
    expect(standardColumns('2027-03-31').map((p) => p?.label)).toEqual(['Q4 FY27', 'Q3 FY27', 'Q4 FY26', 'FY27', 'FY26']);
  });

  it('repairs OCR spacing inside figures', () => {
    expect(repairNumericText('Total Income 318,4 00 12 ,161 10,13 5 {20)')).toBe('Total Income 318,400 12,161 10,135 (20)');
    expect(repairSplitTokens(['174,668', '16', '6,013', '130,610'], 3)).toEqual(['174,668', '166,013', '130,610']);
    expect(repairSplitTokens(['1', '2', '3', '4'], 2)).toBeNull();
  });

  it('extracts figures with their printed text, page, row, column and a passed arithmetic check', () => {
    const r = parseResultsPages([{ pageNumber: 4, text: RESULTS_PAGE }], ctx);
    const pat = r.facts.find((f) => f.metric === 'profit_after_tax' && f.period.label === 'Q2 FY27');
    expect(pat).toMatchObject({ value: 131e7, reportedText: '131', reportedScale: 'crore', basis: 'consolidated', verificationStatus: 'checks_passed', sourceLocation: { page: 4 } });
    // H1 FY27 = Q1 + Q2 confirms the column mapping.
    expect(r.facts.find((f) => f.metric === 'revenue_from_operations' && f.period.label === 'H1 FY27')).toMatchObject({ value: 2420e7, verificationStatus: 'checks_passed' });
  });

  it('marks figures as failing when PBT − tax ≠ PAT', () => {
    const r = parseResultsPages([{ pageNumber: 1, text: RESULTS_PAGE.replace('Profit After Tax 131', 'Profit After Tax 139') }], ctx);
    expect(r.facts.find((f) => f.metric === 'pbt' && f.period.label === 'Q2 FY27')?.verificationStatus).toBe('check_failed');
    expect(r.diagnostics.join(' ')).toMatch(/PBT 176 − tax 45 ≠ PAT 139/);
  });

  it('never lets a repaired (split-figure) row pass on other rows’ arithmetic', () => {
    const r = parseResultsPages([{ pageNumber: 2, text: STANDALONE_PAGE }], ctx);
    const rev = r.facts.find((f) => f.metric === 'revenue_from_operations' && f.period.label === 'Q1 FY27');
    expect(rev).toMatchObject({ value: 16013e7, reportedText: '16,013', verificationStatus: 'unverified' });
    expect(r.facts.find((f) => f.metric === 'pbt' && f.period.label === 'Q1 FY27')?.verificationStatus).toBe('checks_passed');
    // An ambiguous split (no grouping to guide the merge) is dropped, not guessed.
    expect(r.facts.some((f) => f.metric === 'other_income')).toBe(false);
    expect(r.diagnostics.join(' ')).toMatch(/Other Income" has 4 figures where the table has 3; row not used/);
  });

  it('skips pages whose unit or basis is not stated (no unit guessing)', () => {
    const noUnit = RESULTS_PAGE.replace('(₹ in crore)\n', '');
    const r = parseResultsPages([{ pageNumber: 1, text: noUnit }], ctx);
    expect(r.facts).toHaveLength(0);
    expect(r.diagnostics.join(' ')).toMatch(/unit .* not stated/);
    const noBasis = RESULTS_PAGE.replace('CONSOLIDATED ', '');
    expect(parseResultsPages([{ pageNumber: 1, text: noBasis }], ctx).diagnostics.join(' ')).toMatch(/basis/);
  });

  it('converts lakh-denominated filings with the stated scale', () => {
    const r = parseResultsPages([{ pageNumber: 1, text: RESULTS_PAGE.replace('(₹ in crore)', '(₹ in lakhs)') }], ctx);
    expect(r.facts.find((f) => f.metric === 'profit_after_tax')).toMatchObject({ value: 131e5, reportedScale: 'lakh' });
  });

  it('returns nothing rather than guessing when the period is not stated', () => {
    expect(parseResultsPages([{ pageNumber: 1, text: 'Revenue from Operations 100 90' }], ctx)).toMatchObject({ quarterEnd: null, facts: [] });
  });
});

// ---------------------------------------------------------------- facts view

describe('FactsView arithmetic and integrity', () => {
  const q2 = Q('2026-09-30');
  const q2ly = Q('2025-09-30');
  const base = [
    fact('revenue_from_operations', '1,240', q2),
    fact('revenue_from_operations', '1,050', q2ly),
    fact('pbt', '176', q2),
    fact('finance_costs', '18', q2),
    fact('depreciation_amortisation', '54', q2),
  ];

  it('computes EBITDA, margin and YoY exactly, naming formula and inputs', () => {
    const v = new FactsView(base);
    const e = v.ebitda('consolidated', 'quarter', q2.end);
    expect(e).toMatchObject({ kind: 'value', value: 248e7 });
    const m = v.margin('consolidated', 'ebitda', 'quarter', q2.end);
    expect(m.kind === 'value' && m.value).toBeCloseTo(0.2, 12);
    const g = v.yoy('consolidated', 'revenue_from_operations', 'quarter', q2.end);
    expect(g.kind === 'value' && g.value).toBeCloseTo(190 / 1050, 12);
    expect(e.kind === 'value' && e.formula).toMatch(/PBT \+ finance costs/);
  });

  it('reports a missing input instead of treating it as zero', () => {
    const v = new FactsView(base.filter((f) => f.metric !== 'depreciation_amortisation'));
    expect(v.ebitda('consolidated', 'quarter', q2.end)).toMatchObject({ kind: 'not_computable', reason: expect.stringMatching(/depreciation_amortisation not available/) });
  });

  it('surfaces contradictory verified figures as a conflict', () => {
    const v = new FactsView([...base, fact('revenue_from_operations', '1,310', q2, { doc: 'other', page: 9 })]);
    expect(v.get('consolidated', 'revenue_from_operations', 'quarter', q2.end).kind).toBe('conflict');
  });

  it('prefers verified figures and never displays a check_failed one', () => {
    const v = new FactsView([fact('pbt', '999', q2, { status: 'check_failed' })]);
    expect(v.get('consolidated', 'pbt', 'quarter', q2.end)).toMatchObject({ kind: 'missing', reason: expect.stringMatching(/failed consistency checks/) });
  });

  it('does not compare standalone with consolidated', () => {
    const v = new FactsView([fact('revenue_from_operations', '1,240', q2), fact('revenue_from_operations', '1,050', q2ly, { basis: 'standalone' })]);
    expect(v.yoy('consolidated', 'revenue_from_operations', 'quarter', q2.end).kind).toBe('not_computable');
  });
});

// ---------------------------------------------------------------- statements and scorecard

describe('management statements', () => {
  const chunks = TRANSCRIPT_PAGES.map((text, i) => ({ id: `c${i}`, text }));
  const drafts = extractStatements(chunks);
  const find = (s: string) => drafts.find((d) => d.quote.includes(s));

  it('keeps verbatim quotes and speakers, and drops analyst questions', () => {
    expect(find('in the range of 19% to 20%')).toMatchObject({ speaker: 'Asha Rao', subject: 'ebitda_margin', nature: 'quantitative', targetLow: 19, targetHigh: 20, targetUnit: 'percent', horizonPeriod: 'FY27' });
    expect(drafts.some((d) => d.quote.endsWith('?'))).toBe(false);
  });

  it('does not manufacture numbers from vague statements', () => {
    expect(find('strong growth')).toMatchObject({ nature: 'qualitative', targetLow: null });
    expect(find('double-digit growth')).toMatchObject({ nature: 'qualitative', targetLow: null, horizonPeriod: null, horizonText: 'medium term' });
  });

  it('records an explicit refusal to guide', () => {
    expect(find('No guidance')).toMatchObject({ subject: 'guidance_policy' });
  });

  it('normalises only explicit horizons', () => {
    expect(explicitHorizon('margins in FY2027')).toBe('FY27');
    expect(explicitHorizon('for 2026-27')).toBe('FY27');
    expect(explicitHorizon('in Q3 FY27')).toBe('Q3 FY27');
    expect(explicitHorizon('over the next few years')).toBeNull();
  });

  it('rejects model-proposed figures that are not in the quote', () => {
    expect(figuresAppearInQuote('margins in the range of 19% to 20% for FY27', [19, 20], 'FY27')).toBe(true);
    expect(figuresAppearInQuote('we expect strong growth', [15], null)).toBe(false);
    expect(figuresAppearInQuote('margins of 19% for FY27', [19], 'FY28')).toBe(false);
  });
});

describe('scorecard', () => {
  const q2 = Q('2026-09-30');
  const view = new FactsView([fact('revenue_from_operations', '1,240', q2), fact('revenue_from_operations', '1,050', Q('2025-09-30')), fact('pbt', '176', q2), fact('finance_costs', '18', q2), fact('depreciation_amortisation', '54', q2)]);
  const s = (o: Partial<Parameters<typeof evaluateStatement>[0]>) =>
    evaluateStatement({ nature: 'quantitative', subject: 'revenue_growth', targetLow: 15, targetHigh: 15, targetUnit: 'percent', horizonText: 'Q2 FY27', horizonPeriod: 'Q2 FY27', quote: 'Revenue growth for Q2 FY27 around 15%', ...o }, view);

  it('evaluates explicit targets with exact arithmetic', () => {
    // Actual 18.10% vs 15% point target.
    expect(s({})).toMatchObject({ verdict: 'exceeded', variancePp: 3.1 });
    expect(s({ targetLow: 18, targetHigh: 20 })).toMatchObject({ verdict: 'met' });
    expect(s({ subject: 'ebitda_margin', targetLow: 21, targetHigh: 22 })).toMatchObject({ verdict: 'missed', variancePp: -1 });
  });

  it('explains every case it will not evaluate', () => {
    expect(s({ nature: 'qualitative' }).verdict).toBe('not_evaluable');
    expect(s({ horizonPeriod: null, horizonText: 'medium term' }).reason).toMatch(/not an explicit reporting period/);
    expect(s({ horizonPeriod: 'FY28' }).verdict).toBe('awaiting_results');
    expect(s({ horizonPeriod: 'Q4 FY26' }).verdict).toBe('actual_unavailable');
    expect(s({ targetUnit: 'inr_crore' }).verdict).toBe('not_evaluable');
    expect(s({ quote: 'Retail segment revenue growth for Q2 FY27 around 15%' }).reason).toMatch(/segment/);
  });
});

// ---------------------------------------------------------------- chunking and retrieval

describe('chunking and retrieval', () => {
  it('keeps table rows apart from prose and never crosses pages', () => {
    expect(classifyLine('Revenue from Operations 332,861 311,850')).toBe('table');
    expect(classifyLine('MANAGEMENT DISCUSSION AND ANALYSIS')).toBe('heading');
    const chunks = chunkSegments([
      { pageNumber: 1, sectionHeading: null, locationLabel: 'p. 1', text: `BUSINESS OVERVIEW\n${'We make specimens for customers. '.repeat(20)}\nRevenue 100 200\nPBT 10 20` },
      { pageNumber: 2, sectionHeading: null, locationLabel: 'p. 2', text: 'Second page prose that stays on its own page.' },
    ]);
    expect(chunks.every((c) => c.pageStart === c.pageEnd)).toBe(true);
    expect(chunks.find((c) => c.kind === 'table')?.text).toBe('Revenue 100 200\nPBT 10 20');
    expect(chunks[0]?.sectionHeading).toBe('BUSINESS OVERVIEW');
  });

  it('builds FTS queries that cannot inject query syntax', () => {
    expect(toFtsQuery('capex" OR 1=1 NEAR(')).toBe('"capex" OR "near"');
    expect(toFtsQuery('of the')).toBeNull();
  });

  it('retrieves chunks per company with page locations', () => {
    const db = seededDb();
    const { documentId, versionId } = seedDocument(db, 'annual_report', 'Annual Report 2026', ['Cover page.', 'We are a specimen manufacturer. Our segments are Alpha and Beta, serving industrial customers across India.']);
    indexVersion(db, { id: versionId, document_id: documentId, extraction_status: 'extracted' }, 'nse:specimen');
    const hits = searchChunks(db, { companyId: 'nse:specimen', query: ['segments'] });
    expect(hits[0]).toMatchObject({ page_start: 2, document_id: documentId });
    expect(searchChunks(db, { companyId: 'nse:other', query: ['segments'] })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- evidence checks

describe('claim verification helpers', () => {
  it('accepts only quotes present in the passage', () => {
    expect(quoteInPassage('serving industrial  customers', 'Our segments serve... serving industrial customers across India.')).toBe(true);
    expect(quoteInPassage('serving retail customers', 'serving industrial customers')).toBe(false);
  });

  it('rejects claims whose figures are absent from their support', () => {
    expect(figuresSupported('Revenue grew 18.1% to ₹1,240 crore', 'revenue +18.1% YoY; 1,240 crore')).toBe(true);
    expect(figuresSupported('Revenue grew 25%', 'revenue +18.1% YoY')).toBe(false);
  });
});

// ---------------------------------------------------------------- engine end to end

describe('runResearch', () => {
  const deps = (db: Db, llm: LlmClient = new UnconfiguredLlmClient()) => ({ db, llm, dataMode: 'fixture' as const, blobDir: tempDir(), now: () => new Date(T0) });
  const company = (db: Db) => listCompanies(db)[0] as NonNullable<ReturnType<typeof listCompanies>[number]>;

  it('returns a partial report, not invented content, when no documents exist', async () => {
    const db = seededDb();
    const { report } = await runResearch(company(db), { ticker: 'SPECIMEN' }, deps(db));
    expect(report.status).toBe('partial');
    expect(report.modules.trajectory).toMatchObject({ status: 'unavailable', data: null });
    expect(report.modules.guidance.status).toBe('unavailable');
    expect(report.modules.bullBear.status).toBe('unavailable');
    expect(Object.keys(report.evidence)).toHaveLength(0);
  });

  it('builds every module from seeded primary documents with resolvable citations', async () => {
    const db = seededDb();
    seedDocument(db, 'quarterly_results', 'Q2 FY27 results', ['Cover', RESULTS_PAGE], null, '2026-10-30T12:00:00Z');
    seedDocument(db, 'earnings_call_transcript', 'Earnings call transcript, Jul 2026', TRANSCRIPT_PAGES, 'Jul 2026');
    seedDocument(db, 'annual_report', 'Annual Report 2026', [`BUSINESS OVERVIEW\n${'Specimen Industries makes precision specimens for laboratories and industrial customers, organised in two segments. '.repeat(4)}`], 'FY26');

    const { report } = await runResearch(company(db), { ticker: 'SPECIMEN', question: 'What are the segments?' }, deps(db));
    expect(ResearchReportSchema.safeParse(report).success).toBe(true);

    const table = report.modules.trajectory.data?.tables.find((t) => t.basis === 'consolidated');
    const rev = table?.rows.find((r) => r.key === 'revenue_from_operations');
    expect(rev?.cells[0]).toMatchObject({ state: 'value', value: 1240e7, verified: true });
    const margin = table?.rows.find((r) => r.key === 'ebitda_margin')?.cells[0];
    expect(margin?.state === 'value' && margin.value).toBeCloseTo(0.2, 12);

    const marginGuidance = report.modules.guidance.data?.statements.find((s) => s.subject === 'ebitda_margin');
    expect(marginGuidance?.evaluation.verdict).toBe('awaiting_results'); // FY27 not yet reported
    const revenueGuidance = report.modules.guidance.data?.statements.find((s) => s.subject === 'revenue_growth' && s.target);
    expect(revenueGuidance?.evaluation).toMatchObject({ verdict: 'exceeded', variancePp: 3.1 });

    // Every cited id resolves to stored evidence with a real page.
    const ids = JSON.stringify(report.modules).match(/"(chunk|fact):[^"]+"/g) ?? [];
    expect(ids.length).toBeGreaterThan(5);
    for (const raw of ids) {
      const e = report.evidence[raw.slice(1, -1)];
      expect(e).toBeDefined();
      expect(e?.page).toBeGreaterThan(0);
    }
    // The revenue figure's evidence quotes the printed row.
    const revEvidence = rev?.cells[0]?.state === 'value' ? report.evidence[rev.cells[0].evidenceIds[0] ?? ''] : undefined;
    expect(revEvidence?.quote).toContain('1,240');
    expect(report.modules.snapshot.data?.mode).toBe('extractive');
  });

  it('discards model output that is not supported by evidence', async () => {
    const db = seededDb();
    seedDocument(db, 'quarterly_results', 'Q2 FY27 results', [RESULTS_PAGE], null, '2026-10-30T12:00:00Z');
    seedDocument(db, 'earnings_call_transcript', 'Earnings call transcript, Jul 2026', TRANSCRIPT_PAGES, 'Jul 2026');
    seedDocument(db, 'annual_report', 'Annual Report 2026', [`BUSINESS OVERVIEW\n${'Specimen Industries makes precision specimens for laboratories and industrial customers, organised in two segments. '.repeat(4)}`], 'FY26');
    const llm = new ScriptedLlm({
      refine_statements: {
        items: [
          // Claims a 25% target the quote does not contain.
          { id: '1', isManagementForwardLooking: true, subject: 'revenue_growth', nature: 'quantitative', targetLow: 25, targetHigh: 25, targetUnit: 'percent', horizonPeriod: 'FY27' },
        ],
      },
      business_snapshot: {
        claims: [
          { text: 'The company has two segments.', evidenceId: 'missing', quote: 'organised in two segments' },
          { text: 'It serves laboratories.', evidenceId: '__first__', quote: 'this sentence is not in the passage' },
        ],
      },
      bull_bear: { bull: [{ text: 'Revenue will triple to 9,999 crore.', evidenceIds: ['E0'], inference: false }], bear: [{ text: 'Unknown risk.', evidenceIds: ['E999'], inference: true }] },
    });
    const { report } = await runResearch(company(db), { ticker: 'SPECIMEN' }, deps(db, llm));
    expect(report.modules.guidance.data?.statements.some((s) => s.target?.low === 25)).toBe(false);
    expect(report.diagnostics.join('\n')).toMatch(/did not appear in the quote/);
    expect(report.modules.snapshot.data?.claims.every((c) => c.kind === 'quotation')).toBe(true); // model claims rejected → extractive
    expect(report.modules.bullBear.data?.bull ?? []).toHaveLength(0);
    expect(report.diagnostics.join('\n')).toMatch(/bull\/bear: 2 model point\(s\) removed/);
  });

  it('selects recent primary documents only, never third-party ones', () => {
    const doc = (o: Partial<Parameters<typeof selectDocuments>[0][number]>) => ({ id: 'x', company_id: 'c', kind: 'earnings_call_transcript' as const, title: 't', period_label: null, published_at: null, source_url: 'u', discovered_via: 'd', origin: 'exchange_filed' as const, availability: 'pending' as const, last_error: null, duplicate_of: null, ...o });
    const s = selectDocuments([
      doc({ id: 'a', period_label: 'Jan 2026' }),
      doc({ id: 'b', period_label: 'Jul 2026' }),
      doc({ id: 'c', period_label: 'Apr 2026' }),
      doc({ id: 'd', period_label: 'Oct 2025' }),
      doc({ id: 'e', period_label: 'Jul 2025' }),
      doc({ id: 'f', period_label: 'Oct 2026', origin: 'third_party' }),
    ]);
    expect(s.transcripts.map((d) => d.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});

// ---------------------------------------------------------------- model client

describe('AnthropicLlmClient', () => {
  const schema = z.strictObject({ answer: z.string() });
  const req = { task: 't', promptVersion: 'v1', tier: 'extraction' as const, system: 's', input: 'i', schema };
  const message = (over: Record<string, unknown>) => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: '{"answer":"ok"}' }], usage: { input_tokens: 10, output_tokens: 5 }, ...over });
  const transport = (responses: unknown[]) => {
    let n = 0;
    const t = { calls: 0, create: async () => ((t.calls += 1), responses[Math.min(n++, responses.length - 1)]) };
    return t as unknown as MessagesTransport & { calls: number };
  };

  it('caches validated outputs so identical requests are sent once', async () => {
    const db = seededDb();
    const t = transport([message({})]);
    const client = new AnthropicLlmClient(db, { extraction: 'claude-haiku-5-5', synthesis: 'claude-opus-5-5' }, t);
    expect(await client.run(req)).toMatchObject({ status: 'ok', output: { answer: 'ok' }, cached: false });
    expect(await client.run(req)).toMatchObject({ status: 'ok', cached: true });
    expect(t.calls).toBe(1);
  });

  it('reports refusals, truncation and invalid output as failures, recorded for observability', async () => {
    const db = seededDb();
    const models = { extraction: 'claude-haiku-5-5', synthesis: 'claude-opus-5-5' };
    expect(await new AnthropicLlmClient(db, models, transport([message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } })])).run({ ...req, input: 'a' })).toMatchObject({ status: 'failed', reason: 'refused' });
    expect(await new AnthropicLlmClient(db, models, transport([message({ stop_reason: 'max_tokens' })])).run({ ...req, input: 'b' })).toMatchObject({ status: 'failed', reason: 'truncated' });
    expect(await new AnthropicLlmClient(db, models, transport([message({ content: [{ type: 'text', text: '{"wrong":1}' }] })])).run({ ...req, input: 'c' })).toMatchObject({ status: 'failed', reason: 'invalid_output' });
    expect(db.prepare(`SELECT status FROM llm_call ORDER BY status`).all()).toEqual([{ status: 'invalid_output' }, { status: 'invalid_output' }, { status: 'refused' }]);
  });

  it('is never called when no model is configured', async () => {
    expect(await new UnconfiguredLlmClient().run()).toEqual({ status: 'unavailable', reason: 'no model configured' });
  });
});
