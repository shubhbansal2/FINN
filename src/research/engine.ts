import { createHash, randomUUID } from 'node:crypto';

import type { FilingsAdapter } from '@/data/filings/types';
import type { HttpDeps } from '@/data/http';
import type { Db } from '@/db/connection';
import {
  factsForCompany,
  getDocument,
  lastFetch,
  latestVersion,
  listDocuments,
  pagesOfVersion,
  type CompanyRow,
  type DocumentRow,
} from '@/db/repositories';
import { safeDocumentUrl } from '@/ui/evidence';
import { isPrimarySource } from '@/domain/documents';
import { formatSignedPercent } from '@/ui/format';
import { ingestFilings, filingsRequestKey } from '@/ingest/filings';
import { processDocument } from '@/ingest/documents';
import { storeResultsFacts } from '@/ingest/results';
import type { LlmClient } from '@/llm/client';

import { FactsView, type DerivedCell, type FactCell } from './facts-view';
import { extractStatements, figuresAppearInQuote, GUIDANCE_EXTRACTOR_VERSION, type StatementDraft } from './guidance';
import { chunksOfDocument, indexVersion, searchChunks, type ChunkRow } from './index';
import { ANSWER, BULL_BEAR, figuresSupported, quoteInPassage, REFINE_STATEMENTS, SNAPSHOT } from './prompts';
import { ENGINE_VERSION, ResearchReportSchema, type Claim, type EvidenceItem, type ReportCell, type ResearchReport, type ResearchRequest, type StatementView } from './report';
import { RESULTS_PARSER_VERSION } from './results-parser';
import { evaluateStatement } from './scorecard';
import { periodEnding, type FinancialFact, type PeriodType, type StatementBasis } from '@/domain/facts';

export type EngineDeps = {
  db: Db;
  llm: LlmClient;
  dataMode: 'live' | 'fixture';
  blobDir: string;
  now: () => Date;
  http?: HttpDeps;
  filings?: FilingsAdapter;
  log?: (line: string) => void;
  /** Progress for live status displays: research stages and each source as it is processed. */
  onProgress?: (event: ProgressEvent) => void;
};

export type ResearchStage = 'retrieving' | 'extracting' | 'validating' | 'analysing';
export type ProgressEvent = { type: 'stage'; stage: ResearchStage; message: string } | { type: 'source'; source: ResearchReport['sources'][number] };

const KIND_LABEL: Record<string, string> = {
  annual_report: 'Annual report',
  quarterly_results: 'Results filing',
  earnings_call_transcript: 'Concall transcript',
  investor_presentation: 'Investor presentation',
  announcement_attachment: 'Exchange filing',
};

/** Why a section shows source material instead of model text: no model, a failed call, or claims that failed verification. */
function fallbackReason(configured: boolean, failure: string | null): string {
  if (!configured) return 'no model configured';
  if (failure) return `model unavailable: ${failure}`;
  return 'the model\'s claims did not pass verification against the sources';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Sort key for screener's call labels ("Jul 2026"); unknown labels sort last. */
function callMonthKey(label: string | null): number {
  const m = /([a-z]{3})[a-z]*\s+(\d{4})/i.exec(label ?? '');
  if (!m?.[1] || !m[2]) return 0;
  return Number(m[2]) * 12 + MONTHS.indexOf(m[1].toLowerCase());
}

const fyKey = (label: string | null) => Number(/FY(\d{2})/.exec(label ?? '')?.[1] ?? 0);

/** Picks the primary documents a research run needs. Selection is by kind and recency only. */
export function selectDocuments(docs: DocumentRow[]) {
  const primary = docs.filter((d) => isPrimarySource(d.origin) && !d.duplicate_of);
  const byPublished = (a: DocumentRow, b: DocumentRow) => (b.published_at ?? '').localeCompare(a.published_at ?? '');
  return {
    results: primary.filter((d) => d.kind === 'quarterly_results').sort(byPublished).slice(0, 2),
    transcripts: primary
      .filter((d) => d.kind === 'earnings_call_transcript')
      .sort((a, b) => callMonthKey(b.period_label) - callMonthKey(a.period_label))
      .slice(0, 4),
    annualReport: primary.filter((d) => d.kind === 'annual_report').sort((a, b) => fyKey(b.period_label) - fyKey(a.period_label)).slice(0, 1),
    presentation: primary
      .filter((d) => d.kind === 'investor_presentation')
      .sort((a, b) => callMonthKey(b.period_label) - callMonthKey(a.period_label))
      .slice(0, 1),
  };
}

type Ctx = {
  deps: EngineDeps;
  company: CompanyRow;
  evidence: Map<string, EvidenceItem>;
  diagnostics: string[];
  modelCalls: ResearchReport['model']['calls'];
};

/**
 * The latest quarter that had ended before a call held in `label`'s month
 * ("Jul 2026" → Q1 FY27). Indian results calls follow the quarter they report,
 * so this is the quarter the call most likely discusses; callers present it
 * as an inference.
 */
export function quarterBeforeMonth(label: string | null): string | null {
  const m = label?.trim().toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] ?? '') + 1;
  if (month === 0) return null;
  // Quarter ends are Mar, Jun, Sep and Dec; a call in Jan–Mar follows the December quarter of the previous year.
  const endMonth = [9, 6, 3].find((q) => q < month) ?? 12;
  const year = Number(m[2]) - (endMonth === 12 ? 1 : 0);
  const end = new Date(Date.UTC(year, endMonth, 0)).toISOString().slice(0, 10);
  const p = periodEnding('quarter', end);
  return p.ok ? p.value.label : null;
}

const PASSAGE_CHARS = 2_400;

/**
 * The stored passage for a chunk: the whole chunk when short, otherwise a
 * window that contains the quoted span, so the quote can always be shown in
 * its context and re-checked in the evidence panel.
 */
export function passageFor(text: string, quote: string | null, size = PASSAGE_CHARS): string {
  if (text.length <= size) return text;
  if (quote) {
    const words = quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const m = new RegExp(words.join('\\s+'), 'i').exec(text);
    if (m) {
      const extra = Math.max(0, size - m[0].length);
      const start = Math.max(0, Math.min(m.index - Math.floor(extra / 2), text.length - size));
      return text.slice(start, Math.max(start + size, m.index + m[0].length));
    }
  }
  return text.slice(0, size);
}

function chunkEvidence(ctx: Ctx, doc: DocumentRow, chunk: ChunkRow, quote: string | null, extraction: string): string {
  const id = `chunk:${chunk.id}`;
  if (!ctx.evidence.has(id)) {
    ctx.evidence.set(id, {
      id,
      documentId: doc.id,
      documentTitle: doc.title,
      documentKind: KIND_LABEL[doc.kind] ?? 'Exchange filing',
      publishedAt: doc.published_at,
      origin: doc.origin === 'company_issued' ? 'company_issued' : 'exchange_filed',
      page: chunk.page_start,
      locationLabel: chunk.location_label,
      passage: passageFor(chunk.text, quote),
      quote,
      url: safeDocumentUrl(doc.source_url, chunk.page_start ?? undefined),
      verification: 'verified',
      basis: quote ? 'quote' : 'passage',
      reported: null,
      extraction,
    });
  }
  return id;
}

/** Page text for any stored document, loaded on demand and cached for the run. */
function pageText(ctx: Ctx, documentId: string, page: number, cache: Map<string, string>): string {
  const key = `${documentId}:${page}`;
  if (!cache.has(key)) {
    const v = latestVersion(ctx.deps.db, documentId);
    for (const p of v ? pagesOfVersion(ctx.deps.db, v.id) : []) cache.set(`${documentId}:${p.pageNumber}`, p.text);
    if (!cache.has(key)) cache.set(key, '');
  }
  return cache.get(key) ?? '';
}

/** Evidence for a reported figure: the printed row line on its page, verbatim, when it can be found. */
function factEvidence(ctx: Ctx, fact: FinancialFact, docs: Map<string, DocumentRow>, pageCache: Map<string, string>): string {
  const page = fact.sourceLocation.page ?? null;
  // One evidence item per figure: the period is part of the identity, since one page prints several periods' columns.
  const id = `fact:${fact.sourceDocumentId}:${page}:${fact.metric}:${fact.basis}:${fact.period.type}:${fact.period.end}`;
  if (ctx.evidence.has(id)) return id;
  const doc = docs.get(fact.sourceDocumentId);
  const text = page !== null ? pageText(ctx, fact.sourceDocumentId, page, pageCache) : '';
  const lines = text.split('\n');
  const rowKey = (fact.sourceLocation.rowLabel ?? '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 24);
  const idx = lines.findIndex((l) => rowKey.length > 0 && l.toLowerCase().replace(/[^a-z]/g, '').startsWith(rowKey));
  const passage = idx >= 0 ? lines.slice(Math.max(0, idx - 3), idx + 4).join('\n') : text.slice(0, 1_200);
  ctx.evidence.set(id, {
    id,
    documentId: fact.sourceDocumentId,
    documentTitle: doc?.title ?? 'Unknown document',
    documentKind: KIND_LABEL[doc?.kind ?? ''] ?? 'Results filing',
    publishedAt: doc?.published_at ?? null,
    origin: doc?.origin === 'company_issued' ? 'company_issued' : 'exchange_filed',
    page,
    locationLabel: page !== null ? `p. ${page}` : (fact.sourceLocation.section ?? 'location unknown'),
    passage: passage || '(page text unavailable)',
    quote: idx >= 0 ? (lines[idx] ?? null) : null,
    url: doc ? safeDocumentUrl(doc.source_url, page ?? undefined) : null,
    verification: fact.verificationStatus === 'checks_passed' || fact.verificationStatus === 'human_verified' ? 'verified' : fact.verificationStatus === 'check_failed' ? 'check_failed' : 'unverified',
    basis: 'arithmetic',
    reported:
      fact.reportedText && fact.reportedScale && fact.value !== null
        ? { printed: fact.reportedText, scale: fact.reportedScale, normalizedInr: fact.value, period: fact.period.label, basis: fact.basis }
        : null,
    extraction: `${fact.extractionMethod} (${fact.extractorVersion}); row "${fact.sourceLocation.rowLabel ?? ''}", ${fact.sourceLocation.columnLabel ?? ''}`,
  });
  if (idx < 0) ctx.diagnostics.push(`evidence for ${fact.metric} ${fact.period.label}: row text not located on p. ${page}; page reference kept, quote omitted`);
  return id;
}

function toCell(c: FactCell | DerivedCell, ev: (f: FinancialFact) => string, unit: 'inr' | 'ratio'): ReportCell {
  if (c.kind === 'value' && 'fact' in c) return { state: 'value', value: c.value, unit, verified: c.verified, formula: null, evidenceIds: [ev(c.fact)] };
  if (c.kind === 'value') return { state: 'value', value: c.value, unit, verified: c.verified, formula: c.formula, evidenceIds: c.inputs.map(ev) };
  if (c.kind === 'conflict') return { state: 'conflict', reason: `sources disagree: ${c.candidates.map((f) => `${f.reportedText} (p. ${f.sourceLocation.page})`).join(' vs ')}`, evidenceIds: c.candidates.map(ev) };
  if (c.kind === 'missing') return { state: 'missing', reason: c.reason };
  return { state: 'missing', reason: c.reason };
}

const sourceOf = (doc: DocumentRow) => ({
  documentId: doc.id,
  title: doc.title,
  kind: doc.kind,
  origin: doc.origin,
  url: doc.source_url,
  periodLabel: doc.period_label,
  publishedAt: doc.published_at,
  state: 'not_attempted' as ResearchReport['sources'][number]['state'],
  detail: null as string | null,
  pages: null as number | null,
});

/** Fetches (live mode), extracts and indexes one document; never throws for document-level failures. */
async function prepareDocument(ctx: Ctx, doc: DocumentRow) {
  const source = sourceOf(doc);
  const { db } = ctx.deps;
  let version = latestVersion(db, doc.id);
  if (!version) {
    if (ctx.deps.dataMode !== 'live') {
      source.detail = 'not downloaded; documents are only fetched in live mode';
      return { source, version: null };
    }
    ctx.deps.log?.(`  fetching ${KIND_LABEL[doc.kind] ?? doc.kind}: ${doc.title.slice(0, 70)}`);
    ctx.deps.onProgress?.({ type: 'stage', stage: 'retrieving', message: `Downloading ${KIND_LABEL[doc.kind] ?? doc.kind}: ${doc.title.slice(0, 80)}` });
    const r = await processDocument(db, doc.id, { blobDir: ctx.deps.blobDir, now: ctx.deps.now, http: ctx.deps.http });
    if (r.outcome === 'download_failed') {
      source.state = 'download_failed';
      source.detail = r.message;
      return { source, version: null };
    }
    version = latestVersion(db, doc.id);
  }
  if (!version) return { source, version: null };
  source.pages = version.page_count;
  if (version.extraction_status === 'no_text_layer') {
    source.state = 'no_text';
    source.detail = version.extraction_error;
    return { source, version: null };
  }
  if (version.extraction_status === 'failed') {
    source.state = 'extraction_failed';
    source.detail = version.extraction_error;
    return { source, version: null };
  }
  ctx.deps.onProgress?.({ type: 'stage', stage: 'extracting', message: `Extracting and indexing ${KIND_LABEL[doc.kind] ?? doc.kind} (${version.page_count ?? '?'} pages)` });
  indexVersion(db, version, ctx.company.id);
  source.state = 'used';
  source.detail = version.extraction_status === 'partial' ? version.extraction_error : null;
  return { source, version };
}

/** Deterministic statement extraction, optionally refined by the model; the model can only filter and label verbatim quotes. */
async function statementsFor(ctx: Ctx, doc: DocumentRow): Promise<{ drafts: (StatementDraft & { method: string })[]; chunks: Map<string, ChunkRow> }> {
  const chunks = chunksOfDocument(ctx.deps.db, doc.id);
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const drafts = extractStatements(chunks).map((d) => ({ ...d, method: GUIDANCE_EXTRACTOR_VERSION }));
  if (!ctx.deps.llm.configured || drafts.length === 0) return { drafts, chunks: byId };

  const input = JSON.stringify(drafts.map((d, i) => ({ id: String(i), quote: d.quote, speaker: d.speaker, context: (byId.get(d.chunkId)?.text ?? '').slice(0, 1_200) })));
  const r = await ctx.deps.llm.run({ task: REFINE_STATEMENTS.task, promptVersion: REFINE_STATEMENTS.version, tier: 'extraction', system: REFINE_STATEMENTS.system, input, schema: REFINE_STATEMENTS.schema });
  ctx.modelCalls.push({ task: REFINE_STATEMENTS.task, model: r.status === 'unavailable' ? null : r.model, status: r.status === 'failed' ? `failed: ${r.reason}` : r.status, cached: r.status === 'ok' && r.cached });
  if (r.status !== 'ok') {
    ctx.diagnostics.push(`statement refinement for "${doc.title}" not applied (${r.status === 'failed' ? r.message : r.reason}); rule-based statements kept`);
    return { drafts, chunks: byId };
  }
  const refined: (StatementDraft & { method: string })[] = [];
  let rejected = 0;
  for (const item of r.output.items) {
    const d = drafts[Number(item.id)];
    if (!d || !item.isManagementForwardLooking) continue;
    const quantitative = item.nature === 'quantitative' && item.targetLow !== null;
    if (quantitative && !figuresAppearInQuote(d.quote, [item.targetLow, item.targetHigh], item.horizonPeriod)) {
      rejected += 1;
      refined.push({ ...d, subject: item.subject, method: `${REFINE_STATEMENTS.version} (figures not in quote; rule values kept)` });
      continue;
    }
    refined.push({
      ...d,
      subject: item.subject,
      nature: quantitative ? 'quantitative' : 'qualitative',
      targetLow: quantitative ? item.targetLow : null,
      targetHigh: quantitative ? (item.targetHigh ?? item.targetLow) : null,
      targetUnit: quantitative ? item.targetUnit : null,
      horizonPeriod: item.horizonPeriod && figuresAppearInQuote(d.quote, [], item.horizonPeriod) ? item.horizonPeriod : d.horizonPeriod,
      method: REFINE_STATEMENTS.version,
    });
  }
  if (rejected) ctx.diagnostics.push(`${rejected} model-proposed target(s) in "${doc.title}" did not appear in the quote and were discarded`);
  return { drafts: refined, chunks: byId };
}

function storeStatements(ctx: Ctx, doc: DocumentRow, drafts: (StatementDraft & { method: string })[]): string[] {
  const { db } = ctx.deps;
  const ids: string[] = [];
  db.transaction(() => {
    db.prepare(`DELETE FROM management_statement WHERE document_id = ?`).run(doc.id);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO management_statement (id, company_id, document_id, chunk_id, quote, speaker, subject, nature, target_low, target_high, target_unit, horizon_text, horizon_period, extraction_method, extractor_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of drafts) {
      const id = createHash('sha256').update(`${d.chunkId}\n${d.quote}`).digest('hex').slice(0, 24);
      insert.run(id, ctx.company.id, doc.id, d.chunkId, d.quote, d.speaker, d.subject, d.nature, d.targetLow, d.targetHigh, d.targetUnit, d.horizonText, d.horizonPeriod, d.method.startsWith('refine') ? 'model_refined' : 'rule', d.method, ctx.deps.now().toISOString());
      ids.push(id);
    }
  })();
  return ids;
}

const METRIC_LABEL: Record<string, string> = {
  revenue_from_operations: 'Revenue from operations',
  other_income: 'Other income',
  ebitda: 'EBITDA (derived)',
  ebitda_margin: 'EBITDA margin (derived)',
  pbt: 'Profit before tax',
  profit_after_tax: 'Profit after tax',
  profit_after_associates: 'PAT incl. associates & JVs',
  pat_margin: 'PAT margin (derived)',
  finance_costs: 'Finance costs',
  depreciation_amortisation: 'Depreciation & amortisation',
};

function periodColumns(view: FactsView, basis: StatementBasis, upTo: string | null) {
  const cols: { label: string; end: string; type: PeriodType }[] = [];
  for (const type of ['quarter', 'half_year', 'nine_months', 'financial_year'] as const) {
    for (const end of view.periods(basis, type)) {
      if (upTo && end > upTo) continue;
      const f = view.facts.find((x) => x.basis === basis && x.period.type === type && x.period.end === end);
      if (f) cols.push({ label: f.period.label, end, type });
    }
  }
  // Quarters newest first, then year-to-date and full-year columns.
  return cols.slice(0, 8);
}

function periodLimit(period: string | undefined): string | null {
  if (!period) return null;
  const q = /^Q([1-4]) FY(\d{2})$/.exec(period);
  if (q) {
    const fy = 2000 + Number(q[2]);
    return [`${fy - 1}-06-30`, `${fy - 1}-09-30`, `${fy - 1}-12-31`, `${fy}-03-31`][Number(q[1]) - 1] ?? null;
  }
  const fy = /^FY(\d{2})$/.exec(period);
  return fy ? `${2000 + Number(fy[1])}-03-31` : null;
}

export type RunResult = { report: ResearchReport; cached: boolean; reportId: string };

export async function runResearch(company: CompanyRow, request: ResearchRequest, deps: EngineDeps): Promise<RunResult> {
  const { db } = deps;
  const ctx: Ctx = { deps, company, evidence: new Map(), diagnostics: [], modelCalls: [] };

  // 1. Discovery: refresh the company's filings index in live mode if it is older than 12 hours.
  if (deps.dataMode === 'live' && deps.filings) {
    const last = lastFetch(db, filingsRequestKey(company.id));
    const age = last?.finished_at ? deps.now().getTime() - Date.parse(last.finished_at) : Infinity;
    if (age > 12 * 3_600_000) {
      deps.log?.('  refreshing filings index');
      const [r] = await ingestFilings(db, deps.filings, [company], { now: deps.now });
      if (r && r.outcome !== 'stored') ctx.diagnostics.push(`filings index refresh failed (${r.message ?? r.outcome}); using previously discovered documents`);
    }
  }

  const docs = listDocuments(db, { companyId: company.id });
  const selected = selectDocuments(docs);
  deps.onProgress?.({
    type: 'stage',
    stage: 'retrieving',
    message: `Selected ${selected.results.length} results filing(s), ${selected.transcripts.length} transcript(s), ${selected.annualReport.length} annual report(s), ${selected.presentation.length} presentation(s)`,
  });
  const docById = new Map(docs.map((d) => [d.id, d]));
  const sources: ResearchReport['sources'] = [];
  const ready = new Map<string, NonNullable<Awaited<ReturnType<typeof prepareDocument>>['version']>>();
  for (const doc of [...selected.results, ...selected.transcripts, ...selected.annualReport, ...selected.presentation]) {
    const r = await prepareDocument(ctx, doc);
    // Byte-identical copies are detected at download time; use the original only.
    const dup = getDocument(db, doc.id)?.duplicate_of;
    if (dup && ready.has(dup)) {
      const skipped = { ...r.source, state: 'not_attempted' as const, detail: 'identical file to another selected document; not used twice' };
      sources.push(skipped);
      deps.onProgress?.({ type: 'source', source: skipped });
      continue;
    }
    sources.push(r.source);
    deps.onProgress?.({ type: 'source', source: r.source });
    if (r.version) ready.set(doc.id, r.version);
  }
  selected.results = selected.results.filter((d) => ready.has(d.id));

  // Reuse a recent report when nothing it depends on has changed.
  const inputHash = createHash('sha256')
    .update(JSON.stringify({ e: ENGINE_VERSION, p: RESULTS_PARSER_VERSION, g: GUIDANCE_EXTRACTOR_VERSION, v: [...ready.entries()].map(([d, v]) => `${d}:${v.content_sha256}`).sort(), q: request.question ?? null, per: request.period ?? null, m: deps.llm.describe() }))
    .digest('hex');
  const prior = db.prepare(`SELECT id, report FROM research_report WHERE company_id = ? AND input_hash = ? ORDER BY created_at DESC LIMIT 1`).get(company.id, inputHash) as { id: string; report: string } | undefined;
  if (prior) {
    const parsed = ResearchReportSchema.safeParse(JSON.parse(prior.report));
    // A report built while the model was failing is not reused: the next run retries the model.
    if (parsed.success && !parsed.data.model.calls.some((c) => c.status.startsWith('failed'))) return { report: parsed.data, cached: true, reportId: prior.id };
  }

  // 2. Financial facts from results filings (deterministic parser, arithmetic-checked).
  deps.onProgress?.({ type: 'stage', stage: 'validating', message: 'Extracting figures from results filings and checking them arithmetically' });
  for (const doc of selected.results) {
    const version = ready.get(doc.id);
    if (!version) continue;
    const parsed = storeResultsFacts(db, { id: doc.id, company_id: company.id }, version.id, deps.now().toISOString());
    for (const d of parsed.diagnostics) ctx.diagnostics.push(d.startsWith('fact not stored') ? d : `${doc.title.slice(0, 50)}: ${d}`);
  }
  // Facts from byte-identical duplicate documents are excluded; the original carries the same figures.
  const view = new FactsView(factsForCompany(db, company.id).filter((f) => !docById.get(f.sourceDocumentId)?.duplicate_of && !getDocument(db, f.sourceDocumentId)?.duplicate_of));
  const pageCache = new Map<string, string>();
  for (const doc of selected.results) {
    const v = ready.get(doc.id);
    if (v) for (const p of pagesOfVersion(db, v.id)) pageCache.set(`${doc.id}:${p.pageNumber}`, p.text);
  }
  const ev = (f: FinancialFact) => factEvidence(ctx, f, docById, pageCache);
  const upTo = periodLimit(request.period);

  deps.onProgress?.({ type: 'stage', stage: 'analysing', message: 'Building the financial view, guidance scorecard and evidence' });

  // 3. Financial trajectory.
  const tables: NonNullable<ResearchReport['modules']['trajectory']['data']>['tables'] = [];
  for (const basis of ['consolidated', 'standalone'] as const) {
    const cols = periodColumns(view, basis, upTo);
    if (cols.length === 0) continue;
    const metricRow = (key: string, cellFor: (c: (typeof cols)[number]) => ReportCell) => ({ key, label: METRIC_LABEL[key] ?? key, cells: cols.map(cellFor) });
    const raw = (m: string) => metricRow(m, (c) => toCell(view.get(basis, m, c.type, c.end), ev, 'inr'));
    tables.push({
      basis,
      columns: cols,
      rows: [
        raw('revenue_from_operations'),
        metricRow('ebitda', (c) => toCell(view.ebitda(basis, c.type, c.end), ev, 'inr')),
        metricRow('ebitda_margin', (c) => toCell(view.margin(basis, 'ebitda', c.type, c.end), ev, 'ratio')),
        raw('pbt'),
        raw('profit_after_tax'),
        ...(view.facts.some((f) => f.basis === basis && f.metric === 'profit_after_associates') ? [raw('profit_after_associates')] : []),
        metricRow('pat_margin', (c) => toCell(view.margin(basis, 'profit_after_tax', c.type, c.end), ev, 'ratio')),
      ],
    });
  }
  const latestQuarter = view.latestQuarterEnd();
  const highlights: NonNullable<ResearchReport['modules']['trajectory']['data']>['highlights'] = [];
  if (latestQuarter) {
    const hb: StatementBasis = view.periods('consolidated', 'quarter').includes(latestQuarter) ? 'consolidated' : 'standalone';
    const label = view.facts.find((f) => f.period.end === latestQuarter && f.period.type === 'quarter')?.period.label ?? latestQuarter;
    const growthCmp = (basisLabel: string, c: DerivedCell) => ({
      basis: basisLabel,
      kind: 'ratio' as const,
      value: c.kind === 'value' ? c.value : null,
      reason: c.kind === 'value' ? null : c.reason,
      evidenceIds: c.kind === 'value' ? c.inputs.map(ev) : [],
    });
    for (const m of ['revenue_from_operations', 'profit_after_tax'] as const) {
      highlights.push({
        key: m,
        label: m === 'revenue_from_operations' ? 'Revenue' : 'Profit after tax',
        period: label,
        basis: hb,
        cell: toCell(view.get(hb, m, 'quarter', latestQuarter), ev, 'inr'),
        comparisons: [growthCmp('QoQ', view.qoq(hb, m, latestQuarter)), growthCmp('YoY', view.yoy(hb, m, 'quarter', latestQuarter))],
      });
    }
    const margin = view.margin(hb, 'ebitda', 'quarter', latestQuarter);
    const priorEnd = `${Number(latestQuarter.slice(0, 4)) - 1}${latestQuarter.slice(4)}`;
    const priorMargin = view.margin(hb, 'ebitda', 'quarter', priorEnd);
    highlights.push({
      key: 'ebitda_margin',
      label: 'EBITDA margin (derived)',
      period: label,
      basis: hb,
      cell: toCell(margin, ev, 'ratio'),
      comparisons: [
        margin.kind === 'value' && priorMargin.kind === 'value'
          ? { basis: 'YoY', kind: 'pp' as const, value: (margin.value - priorMargin.value) * 100, reason: null, evidenceIds: [...margin.inputs, ...priorMargin.inputs].map(ev) }
          : { basis: 'YoY', kind: 'pp' as const, value: null, reason: margin.kind !== 'value' ? margin.reason : priorMargin.kind !== 'value' ? priorMargin.reason : null, evidenceIds: [] },
      ],
    });
  }
  const trajectory: ResearchReport['modules']['trajectory'] =
    tables.length === 0
      ? { status: 'unavailable', note: selected.results.length === 0 ? 'No results filing was found for this company.' : 'No figures could be extracted from the retrieved results filings.', data: null }
      : {
          status: tables.some((t) => t.rows.some((r) => r.cells.some((c) => c.state !== 'value'))) ? 'partial' : 'ok',
          note: 'Figures as printed in the results filing, ₹ converted from the stated unit. Derived rows show their formula. Columns follow the filing; history is limited to the periods it reports.',
          data: { tables, latestQuarter, highlights },
        };

  // 4. Balance sheet & cash quality: only what the filings yielded; the rest is explained.
  const bsItems: NonNullable<ResearchReport['modules']['balanceSheet']['data']>['items'] = [];
  const lq = latestQuarter;
  if (lq) {
    const ebitda = view.ebitda('consolidated', 'quarter', lq);
    const fin = view.get('consolidated', 'finance_costs', 'quarter', lq);
    let coverage: DerivedCell;
    if (ebitda.kind === 'value' && fin.kind === 'value' && fin.value > 0) {
      coverage = { kind: 'value', value: ebitda.value / fin.value, formula: 'Interest coverage = EBITDA ÷ finance costs (coverage.v1)', inputs: [...ebitda.inputs, fin.fact], verified: ebitda.verified && fin.verified };
    } else {
      coverage = { kind: 'not_computable', reason: ebitda.kind !== 'value' ? ebitda.reason : 'finance costs not available' };
    }
    const label = view.facts.find((f) => f.period.end === lq && f.period.type === 'quarter')?.period.label ?? lq;
    bsItems.push({ key: 'interest_coverage', label: 'Interest coverage (×)', period: label, cell: toCell(coverage, ev, 'ratio'), explanation: 'How many times quarterly EBITDA covers finance costs.' });
  }
  const cfo = view.facts.find((f) => f.metric === 'cash_from_operations' && f.basis === 'consolidated');
  bsItems.push(
    cfo
      ? { key: 'cash_from_operations', label: 'Cash from operations', period: cfo.period.label, cell: toCell(view.get('consolidated', 'cash_from_operations', cfo.period.type, cfo.period.end), ev, 'inr'), explanation: 'As printed in the cash-flow statement.' }
      : { key: 'cash_from_operations', label: 'Cash from operations', period: null, cell: { state: 'missing', reason: 'cash-flow statement rows were not extracted from the retrieved filings' }, explanation: 'Needed for cash conversion and free cash flow.' },
  );
  // Never computed yet: each is listed with what it needs, whether or not cash from operations was found.
  for (const [key, label, why] of [
    ['borrowings', 'Total borrowings', 'Balance-sheet rows print labels and figures in separate columns in these filings; the rule parser does not align them yet.'],
    ['debt_to_equity', 'Debt to equity', 'Requires total borrowings and total equity from the balance sheet, which are not extracted yet.'],
    [
      'free_cash_flow',
      'Free cash flow',
      cfo ? 'Capital expenditure is not extracted from the cash-flow statement yet, so cash from operations cannot be reduced by it.' : 'Requires cash from operations and capital expenditure from the cash-flow statement.',
    ],
    [
      'cash_conversion',
      'Cash conversion (CFO ÷ EBITDA)',
      cfo ? `Cash from operations is reported for ${cfo.period.label}; FINN does not divide it by EBITDA for a different period, and same-period conversion is not computed yet.` : 'Requires cash from operations for the same period as EBITDA.',
    ],
    ['working_capital', 'Working-capital cycle', 'Requires inventories, receivables and payables from the balance sheet.'],
  ] as const) {
    bsItems.push({ key, label, period: null, cell: { state: 'missing', reason: why }, explanation: why });
  }
  const balanceSheet: ResearchReport['modules']['balanceSheet'] = {
    status: bsItems.some((i) => i.cell.state === 'value') ? 'partial' : 'unavailable',
    note: 'Only metrics computable from extracted figures are shown; missing metrics say what is needed.',
    data: { items: bsItems },
  };

  // 5. Management statements, guidance and scorecard.
  const statementViews: StatementView[] = [];
  const calls: NonNullable<ResearchReport['modules']['scorecard']['data']>['calls'] = [];
  for (const doc of selected.transcripts) {
    if (!ready.get(doc.id)) continue;
    const { drafts, chunks } = await statementsFor(ctx, doc);
    const ids = storeStatements(ctx, doc, drafts);
    const callLabel = doc.period_label ? `${doc.period_label} call` : doc.title;
    drafts.forEach((d, i) => {
      const chunk = chunks.get(d.chunkId);
      if (!chunk) return;
      const evaluation = evaluateStatement(d, view);
      const actualEvidenceIds: string[] = [];
      statementViews.push({
        id: ids[i] ?? `${doc.id}:${i}`,
        callLabel,
        quote: d.quote,
        speaker: d.speaker,
        subject: d.subject,
        nature: d.nature,
        target: d.nature === 'quantitative' && d.targetLow !== null && d.targetUnit ? { low: d.targetLow, high: d.targetHigh ?? d.targetLow, unit: d.targetUnit } : null,
        horizonText: d.horizonText,
        horizonPeriod: d.horizonPeriod,
        evidenceId: chunkEvidence(ctx, doc, chunk, d.quote, d.method),
        method: d.method,
        evaluation: {
          verdict: evaluation.verdict,
          reason: evaluation.reason,
          actualPercent: evaluation.actual ? evaluation.actual.value * 100 : null,
          variancePp: evaluation.variancePp,
          method: evaluation.method,
          actualVerified: evaluation.actual?.verified ?? null,
          actualEvidenceIds,
        },
      });
    });
    calls.push({ callLabel, documentId: doc.id, statementIds: statementViews.filter((s) => s.callLabel === callLabel).map((s) => s.id), inferredQuarter: quarterBeforeMonth(doc.period_label) });
  }
  const counts: Record<string, number> = {};
  for (const s of statementViews) counts[s.evaluation.verdict] = (counts[s.evaluation.verdict] ?? 0) + 1;
  const transcriptsUsed = selected.transcripts.filter((d) => ready.has(d.id)).length;
  const guidance: ResearchReport['modules']['guidance'] =
    transcriptsUsed === 0
      ? { status: 'unavailable', note: selected.transcripts.length === 0 ? 'No earnings-call transcripts were found.' : 'Transcripts could not be retrieved or read.', data: null }
      : {
          status: transcriptsUsed < 4 ? 'partial' : 'ok',
          note: `${statementViews.length} forward-looking statements from ${transcriptsUsed} call(s), verbatim. Targets are recorded only when stated with a figure.`,
          data: { statements: statementViews },
        };
  const evaluated = statementViews.filter((s) => ['met', 'exceeded', 'missed'].includes(s.evaluation.verdict)).length;
  const scorecard: ResearchReport['modules']['scorecard'] =
    transcriptsUsed === 0
      ? { status: 'unavailable', note: 'No transcripts to score.', data: null }
      : {
          status: evaluated > 0 ? 'ok' : 'partial',
          note:
            evaluated > 0
              ? `${evaluated} statement(s) evaluated against reported figures.`
              : 'No statement could be scored against a reported figure: each row says why (qualitative, horizon not explicit, not yet reported, or figures not extracted).',
          data: { calls, counts },
        };

  // 6. Narrative vs numbers: each quantitative or measurable statement next to the related reported figures.
  const narrativeItems: NonNullable<ResearchReport['modules']['narrative']['data']>['items'] = [];
  if (lq) {
    const qLabel = view.facts.find((f) => f.period.end === lq && f.period.type === 'quarter')?.period.label ?? lq;
    const related = (subject: string): Claim[] => {
      const out: Claim[] = [];
      const add = (cell: DerivedCell | FactCell, text: (v: number) => string) => {
        if (cell.kind !== 'value') return;
        const inputs = 'fact' in cell ? [cell.fact] : cell.inputs;
        out.push({ text: text(cell.value), kind: 'fact' in cell ? 'sourced_fact' : 'computed', evidenceIds: inputs.map(ev) });
      };
      if (subject === 'revenue_growth' || subject === 'revenue') add(view.yoy('consolidated', 'revenue_from_operations', 'quarter', lq), (v) => `Reported: consolidated revenue ${formatSignedPercent(v)} YoY in ${qLabel}.`);
      if (subject === 'ebitda_margin' || subject === 'margin' || subject === 'ebitda') add(view.margin('consolidated', 'ebitda', 'quarter', lq), (v) => `Reported: consolidated EBITDA margin ${(v * 100).toFixed(1)}% in ${qLabel} (derived).`);
      if (subject === 'pat') add(view.yoy('consolidated', 'profit_after_tax', 'quarter', lq), (v) => `Reported: consolidated PAT ${formatSignedPercent(v)} YoY in ${qLabel}.`);
      return out;
    };
    for (const s of statementViews) {
      const r = related(s.subject);
      if (r.length) narrativeItems.push({ statementId: s.id, related: r });
    }
  }
  const narrative: ResearchReport['modules']['narrative'] =
    statementViews.length === 0
      ? { status: 'unavailable', note: 'No management statements to compare.', data: null }
      : {
          status: narrativeItems.length ? 'partial' : 'unavailable',
          note: narrativeItems.length
            ? 'Statements shown next to the latest reported figures on the same subject. Placement is not a verdict: only the scorecard evaluates explicit targets.'
            : 'No statement concerned a metric that was extracted from the filings.',
          data: narrativeItems.length ? { items: narrativeItems } : null,
        };

  // 7. Business snapshot.
  const proseDocs = [...selected.annualReport, ...selected.presentation].filter((d) => ready.has(d.id)).map((d) => d.id);
  const snapshotHits = proseDocs.length
    ? searchChunks(db, { companyId: company.id, documentIds: proseDocs, query: ['business overview', 'our businesses', 'business segments', 'company overview', 'segments', 'portfolio', 'we are'], limit: 20 })
        // Prose paragraphs only: no tables, footnotes or slide fragments.
        .filter((h) => h.kind === 'prose' && h.text.length >= 300 && !/^[*•#]/.test(h.text) && (h.text.match(/[a-z]/gi) ?? []).length / h.text.length > 0.6)
        .slice(0, 6)
    : [];
  let snapshot: ResearchReport['modules']['snapshot'];
  if (snapshotHits.length === 0) {
    snapshot = { status: 'unavailable', note: proseDocs.length ? 'No business-overview passages were found in the retrieved documents.' : 'No annual report or investor presentation could be retrieved.', data: null };
  } else {
    const evIds = snapshotHits.map((h) => chunkEvidence(ctx, docById.get(h.document_id) as DocumentRow, h, null, 'retrieval (bm25)'));
    let claims: Claim[] | null = null;
    let snapshotFailure: string | null = null;
    if (deps.llm.configured) {
      const input = JSON.stringify(snapshotHits.map((h, i) => ({ evidenceId: evIds[i], text: h.text.slice(0, 2_000) })));
      const r = await deps.llm.run({ task: SNAPSHOT.task, promptVersion: SNAPSHOT.version, tier: 'synthesis', system: SNAPSHOT.system, input: `Company: ${company.name}\nEvidence:\n${input}`, schema: SNAPSHOT.schema });
      ctx.modelCalls.push({ task: SNAPSHOT.task, model: r.status === 'unavailable' ? null : r.model, status: r.status === 'failed' ? `failed: ${r.reason}` : r.status, cached: r.status === 'ok' && r.cached });
      if (r.status === 'ok') {
        const kept = r.output.claims.filter((c) => {
          const e = ctx.evidence.get(c.evidenceId);
          return e && quoteInPassage(c.quote, e.passage) && figuresSupported(c.text, c.quote);
        });
        if (kept.length < r.output.claims.length) ctx.diagnostics.push(`snapshot: ${r.output.claims.length - kept.length} model claim(s) removed (quote not found in source or unsupported figure)`);
        claims = kept.map((c) => ({ text: c.text, kind: 'sourced_fact' as const, evidenceIds: [c.evidenceId] }));
        kept.forEach((c) => {
          const e = ctx.evidence.get(c.evidenceId);
          if (e && !e.quote) ctx.evidence.set(c.evidenceId, { ...e, quote: c.quote });
        });
      } else if (r.status === 'failed') {
        snapshotFailure = r.message;
        ctx.diagnostics.push(`snapshot synthesis failed (${r.message}); showing source excerpts instead`);
      }
    }
    if (!claims) {
      claims = snapshotHits.slice(0, 4).map((h, i) => {
        const excerpt = h.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 420);
        return { text: excerpt, kind: 'quotation' as const, evidenceIds: [evIds[i] as string] };
      });
    }
    snapshot = {
      status: claims.length ? 'ok' : 'partial',
      note: deps.llm.configured && claims.some((c) => c.kind === 'sourced_fact')
        ? 'Model-written summary; each claim is checked against a verbatim quote from the cited passage.'
        : `Source excerpts (${fallbackReason(deps.llm.configured, snapshotFailure)}): the most relevant passages from the annual report or presentation, quoted verbatim.`,
      data: { mode: claims.some((c) => c.kind === 'sourced_fact') ? 'model' : 'extractive', claims },
    };
  }

  // 8. Bull vs bear.
  const observations: { side: 'bull' | 'bear'; claim: Claim; support: string }[] = [];
  if (lq) {
    const qLabel = view.facts.find((f) => f.period.end === lq && f.period.type === 'quarter')?.period.label ?? lq;
    const push = (cell: DerivedCell, positive: (v: number) => boolean, text: (v: number) => string) => {
      if (cell.kind !== 'value' || !cell.verified) return;
      const claim: Claim = { text: text(cell.value), kind: 'computed', evidenceIds: cell.inputs.map(ev) };
      observations.push({ side: positive(cell.value) ? 'bull' : 'bear', claim, support: claim.text });
    };
    push(view.yoy('consolidated', 'revenue_from_operations', 'quarter', lq), (v) => v > 0, (v) => `Consolidated revenue ${formatSignedPercent(v)} YoY in ${qLabel}.`);
    push(view.yoy('consolidated', 'profit_after_tax', 'quarter', lq), (v) => v > 0, (v) => `Consolidated PAT ${formatSignedPercent(v)} YoY in ${qLabel}.`);
    const m = view.margin('consolidated', 'ebitda', 'quarter', lq);
    const prevEnd = view.periods('consolidated', 'quarter').find((e) => e < lq && e.slice(0, 4) === String(Number(lq.slice(0, 4)) - 1) && e.slice(5) === lq.slice(5));
    if (m.kind === 'value' && prevEnd) {
      const pm = view.margin('consolidated', 'ebitda', 'quarter', prevEnd);
      if (pm.kind === 'value' && m.verified && pm.verified) {
        const delta = (m.value - pm.value) * 100;
        observations.push({
          side: delta >= 0 ? 'bull' : 'bear',
          claim: { text: `Consolidated EBITDA margin ${(m.value * 100).toFixed(1)}% in ${qLabel} vs ${(pm.value * 100).toFixed(1)}% a year earlier (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pp; EBITDA derived).`, kind: 'computed', evidenceIds: [...m.inputs, ...pm.inputs].map(ev) },
          support: '',
        });
      }
    }
  }
  for (const s of statementViews) {
    if (s.evaluation.verdict === 'missed') observations.push({ side: 'bear', claim: { text: `Missed stated target: ${s.evaluation.reason}`, kind: 'computed', evidenceIds: [s.evidenceId] }, support: '' });
    if (s.evaluation.verdict === 'met' || s.evaluation.verdict === 'exceeded') observations.push({ side: 'bull', claim: { text: `Delivered on stated target: ${s.evaluation.reason}`, kind: 'computed', evidenceIds: [s.evidenceId] }, support: '' });
  }
  let bullBear: ResearchReport['modules']['bullBear'];
  const computed = { bull: observations.filter((o) => o.side === 'bull').map((o) => o.claim), bear: observations.filter((o) => o.side === 'bear').map((o) => o.claim) };
  if (deps.llm.configured && (observations.length > 0 || statementViews.length > 0)) {
    const items = [
      ...observations.map((o) => ({ evidenceIds: o.claim.evidenceIds, statement: o.claim.text })),
      ...statementViews.slice(0, 20).map((s) => ({ evidenceIds: [s.evidenceId], statement: `Management (${s.callLabel}): "${s.quote}"` })),
      ...(snapshot.data?.claims ?? []).map((c) => ({ evidenceIds: c.evidenceIds, statement: c.text })),
    ].map((x, i) => ({ id: `E${i}`, ...x }));
    const r = await deps.llm.run({ task: BULL_BEAR.task, promptVersion: BULL_BEAR.version, tier: 'synthesis', system: BULL_BEAR.system, input: `Company: ${company.name}\nEvidence items:\n${JSON.stringify(items.map((x) => ({ id: x.id, text: x.statement })))}`, schema: BULL_BEAR.schema });
    ctx.modelCalls.push({ task: BULL_BEAR.task, model: r.status === 'unavailable' ? null : r.model, status: r.status === 'failed' ? `failed: ${r.reason}` : r.status, cached: r.status === 'ok' && r.cached });
    if (r.status === 'ok') {
      const byId = new Map(items.map((x) => [x.id, x]));
      let dropped = 0;
      const verify = (points: { text: string; evidenceIds: string[]; inference: boolean }[]): Claim[] =>
        points.flatMap((p) => {
          const cited = p.evidenceIds.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
          const support = cited.map((c) => c.statement).join('\n');
          if (cited.length !== p.evidenceIds.length || !figuresSupported(p.text, support)) {
            dropped += 1;
            return [];
          }
          return [{ text: p.text, kind: p.inference ? ('inference' as const) : ('sourced_fact' as const), evidenceIds: [...new Set(cited.flatMap((c) => c.evidenceIds))] }];
        });
      const bull = verify(r.output.bull);
      const bear = verify(r.output.bear);
      if (dropped) ctx.diagnostics.push(`bull/bear: ${dropped} model point(s) removed (unknown evidence id or figure not in cited evidence)`);
      bullBear = { status: bull.length && bear.length ? 'ok' : 'partial', note: 'Model-written from the evidence items below only; figures are checked against the cited evidence. Points marked Analysis are interpretation.', data: { mode: 'model', bull, bear } };
    } else {
      bullBear = { status: computed.bull.length || computed.bear.length ? 'partial' : 'unavailable', note: `Model synthesis unavailable (${r.status === 'failed' ? r.message : r.reason}); showing computed observations.`, data: { mode: 'computed', ...computed } };
    }
  } else {
    bullBear =
      computed.bull.length || computed.bear.length
        ? { status: 'partial', note: 'Computed observations from reported figures and scored guidance (no model configured). A written argument needs the model.', data: { mode: 'computed', ...computed } }
        : { status: 'unavailable', note: 'No verified figures or scored statements to argue from.', data: null };
  }

  // 9. Optional question: retrieval across the selected documents, answered by the model if configured.
  let question: ResearchReport['modules']['question'] = { status: 'unavailable', note: 'No question asked.', data: null };
  if (request.question) {
    const hits = searchChunks(db, { companyId: company.id, documentIds: [...ready.keys()], query: request.question, limit: 6 });
    if (hits.length === 0) question = { status: 'unavailable', note: 'Nothing in the retrieved documents matched the question.', data: { question: request.question, mode: 'extractive', claims: [] } };
    else {
      const evIds = hits.map((h) => chunkEvidence(ctx, docById.get(h.document_id) as DocumentRow, h, null, 'retrieval (bm25)'));
      let claims: Claim[] = hits.slice(0, 4).map((h, i) => ({ text: h.text.slice(0, 420), kind: 'quotation' as const, evidenceIds: [evIds[i] as string] }));
      let mode: 'model' | 'extractive' = 'extractive';
      let answerFailure: string | null = null;
      if (deps.llm.configured) {
        const r = await deps.llm.run({ task: ANSWER.task, promptVersion: ANSWER.version, tier: 'synthesis', system: ANSWER.system, input: `Question: ${request.question}\nEvidence:\n${JSON.stringify(hits.map((h, i) => ({ evidenceId: evIds[i], text: h.text.slice(0, 2_000) })))}`, schema: ANSWER.schema });
        ctx.modelCalls.push({ task: ANSWER.task, model: r.status === 'unavailable' ? null : r.model, status: r.status === 'failed' ? `failed: ${r.reason}` : r.status, cached: r.status === 'ok' && r.cached });
        if (r.status === 'ok') {
          const kept = r.output.claims.filter((c) => {
            const e = ctx.evidence.get(c.evidenceId);
            return e && quoteInPassage(c.quote, e.passage) && figuresSupported(c.text, c.quote);
          });
          claims = kept.map((c) => ({ text: c.text, kind: 'sourced_fact' as const, evidenceIds: [c.evidenceId] }));
          mode = 'model';
        } else if (r.status === 'failed') answerFailure = r.message;
      }
      question = { status: claims.length ? 'ok' : 'partial', note: mode === 'model' ? 'Answer written from retrieved passages; each claim checked against a verbatim quote.' : `Most relevant passages, quoted (${fallbackReason(deps.llm.configured, answerFailure)}).`, data: { question: request.question, mode, claims } };
    }
  }

  const modules = { snapshot, trajectory, balanceSheet, guidance, scorecard, narrative, bullBear, question };
  const anyIncomplete = Object.entries(modules).some(([k, m]) => k !== 'question' && m.status !== 'ok') || sources.some((s) => s.state !== 'used');
  const report: ResearchReport = ResearchReportSchema.parse({
    engineVersion: ENGINE_VERSION,
    generatedAt: deps.now().toISOString(),
    dataMode: deps.dataMode,
    status: anyIncomplete ? 'partial' : 'complete',
    company: { id: company.id, name: company.name, nseSymbol: company.nseSymbol, bseCode: company.bseCode, role: company.role },
    request: { ticker: request.ticker, question: request.question ?? null, period: request.period ?? null },
    sources,
    evidence: Object.fromEntries(ctx.evidence),
    modules,
    diagnostics: ctx.diagnostics.slice(0, 80),
    model: { configured: deps.llm.configured, description: deps.llm.describe(), calls: ctx.modelCalls },
  });

  // Every evidence id referenced anywhere must resolve; a dangling reference is a bug, not something to hide.
  const referenced = JSON.stringify(report.modules).match(/"(chunk|fact):[^"]+"/g) ?? [];
  const dangling = referenced.map((s) => s.slice(1, -1)).filter((id) => !report.evidence[id]);
  if (dangling.length) throw new Error(`report references unresolved evidence: ${dangling.slice(0, 3).join(', ')}`);

  const reportId = randomUUID();
  db.prepare(`INSERT INTO research_report (id, company_id, request, input_hash, status, report, data_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    reportId,
    company.id,
    JSON.stringify(request),
    inputHash,
    report.status,
    JSON.stringify(report),
    deps.dataMode,
    report.generatedAt,
  );
  return { report, cached: false, reportId };
}

export type ResearchHistoryItem = { companyId: string; generatedAt: string; status: 'complete' | 'partial' | 'failed' };

/** The most recent stored report per company, newest first. */
export function researchHistory(db: Db, limit = 12): ResearchHistoryItem[] {
  return (
    db
      .prepare(
        `SELECT company_id AS companyId, MAX(created_at) AS generatedAt, status FROM research_report GROUP BY company_id ORDER BY generatedAt DESC LIMIT ?`,
      )
      .all(limit) as ResearchHistoryItem[]
  );
}

export function latestReport(db: Db, companyId: string): ResearchReport | null {
  const row = db.prepare(`SELECT report FROM research_report WHERE company_id = ? ORDER BY created_at DESC LIMIT 1`).get(companyId) as { report: string } | undefined;
  if (!row) return null;
  const parsed = ResearchReportSchema.safeParse(JSON.parse(row.report));
  return parsed.success ? parsed.data : null;
}

