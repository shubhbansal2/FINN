/**
 * FINN data CLI.  Usage: npm run finn -- <command> [--symbols A,B] [--role portfolio|research] [--kinds k1,k2] [--limit N]
 *
 * Commands
 *   migrate            Create/upgrade the database for the current FINN_DATA_MODE.
 *   universe:sync      Load config/universe.json into the database.
 *   universe:verify    Live only. Check each listing resolves at Yahoo; store resolution, not prices.
 *   ingest:prices      Fetch daily OHLCV (live: Yahoo; fixture: recorded files).
 *   ingest:filings     Fetch announcements and document links (live: screener.in; fixture: recorded files).
 *   reclassify         Re-run the current rule classifier over stored announcements (new version row; old rows kept).
 *   reextract          Re-extract stored PDFs whose text came from an older extractor version (no network; re-indexed on next use).
 *   ingest:documents   Live only. Download pending primary documents and extract text.
 *   ingest:results     Live only. Download recent results filings and extract their headline figures (results first cut).
 *   capture:fixtures   Live only. Record current provider responses into fixtures/ for offline demos.
 *   status             Freshness and coverage report.
 *   brief              Print the ranked digest: [--window 24h|3d|7d|30d|YYYY-MM-DD..YYYY-MM-DD].
 *   alerts:evaluate    Evaluate alert rules now and record new alerts (idempotent).
 *   research           Run the research engine: --symbols TICKER [--question "…"] [--period "Q2 FY27"].
 *                      Live only with --record: also writes the report to fixtures/research/ as a labelled demo report.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { dataPaths, readEnv } from '@/config/env';
import { loadUniverse } from '@/config/universe';
import { FixtureFilingsAdapter, fixtureFileName, ScreenerFilingsAdapter, type RecordedFilings } from '@/data/filings/screener';
import type { FilingsAdapter } from '@/data/filings/types';
import { extractPdf, PDF_EXTRACTOR_VERSION } from '@/data/documents/extract';
import { defaultHttpDeps, httpGet } from '@/data/http';
import { FixturePriceAdapter, YahooChartAdapter, type PriceAdapter } from '@/data/prices/yahoo';
import { openDatabase, type Db } from '@/db/connection';
import {
  lastFetch,
  latestTradeDate,
  listAnnouncements,
  listCompanies,
  listDocuments,
  listListings,
  saveClassification,
  saveExtraction,
  setListingResolution,
  upsertCompany,
} from '@/db/repositories';
import { MARKET_DATA_STATUS_LABEL, marketDataStatus } from '@/domain/market';
import { CLASSIFIER_VERSION, classifyAnnouncement } from '@/domain/taxonomy';
import { ingestFilings, filingsRequestKey } from '@/ingest/filings';
import { processDocument } from '@/ingest/documents';
import { ingestPrices, priceRequestKey } from '@/ingest/prices';
import { ingestResultsFilings } from '@/ingest/results';
import { createLlmClient } from '@/llm/client';
import { evaluateAlerts, getDigest } from '@/push/service';
import { runResearch } from '@/research/engine';
import { ResearchRequestSchema } from '@/research/report';
import { resolveCompany } from '@/research/resolve';

const FIXTURES = path.join(process.cwd(), 'fixtures');
const PRICE_FIXTURES = path.join(FIXTURES, 'prices', 'yahoo');
const RESEARCH_FIXTURES = path.join(FIXTURES, 'research');
const FILINGS_FIXTURES = path.join(FIXTURES, 'filings');
const POLITE_PAUSE_MS = 1_200;
/** How far back ingest:results looks for results filings to download and parse. */
const RESULTS_LOOKBACK_DAYS = 60;

type Args = { command: string; symbols: string[] | null; role: 'portfolio' | 'research' | null; kinds: string[] | null; limit: number; question?: string; period?: string; window?: string; record: boolean };

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const get = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);
  const role = get('--role');
  if (role && role !== 'portfolio' && role !== 'research') throw new Error('--role must be portfolio or research');
  const limit = Number(get('--limit') ?? '25');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('--limit must be an integer 1–500');
  return { command, symbols: list(get('--symbols'))?.map((s) => s.toUpperCase()) ?? null, role: (role as Args['role']) ?? null, kinds: list(get('--kinds')), limit, question: get('--question'), period: get('--period'), window: get('--window'), record: rest.includes('--record') };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => new Date();

function selectCompanies(db: Db, args: Args) {
  return listCompanies(db, { role: args.role ?? undefined }).filter(
    (c) => !args.symbols || args.symbols.includes(c.nseSymbol ?? '') || args.symbols.includes(c.bseCode ?? ''),
  );
}

function selectListings(db: Db, args: Args) {
  const companies = new Set(selectCompanies(db, args).map((c) => c.id));
  // Prices come from the NSE listing where one exists; BSE is used only for BSE-only companies.
  const all = listListings(db, { role: args.role ?? undefined });
  const nseCompanies = new Set(all.filter((l) => l.exchange === 'NSE').map((l) => l.company_id));
  return all.filter((l) => companies.has(l.company_id) && (l.exchange === 'NSE' || !nseCompanies.has(l.company_id)));
}

function requireLive(mode: string, command: string) {
  if (mode !== 'live') throw new Error(`${command} needs FINN_DATA_MODE=live (current: ${mode}).`);
}

/** Loads `.env` like the Next.js app does; variables already set in the shell take precedence. */
function loadDotEnv() {
  try {
    process.loadEnvFile('.env');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv();
  const paths = dataPaths(env);
  const db = openDatabase(paths.database);
  const mode = env.FINN_DATA_MODE;
  console.log(`FINN · mode=${mode} · db=${paths.database}`);
  // Windows are measured from the demo clock in fixture mode (as in the app), from the real clock in live mode.
  const windowNow = () => (mode === 'fixture' ? new Date(env.FINN_DEMO_NOW) : now());

  const priceAdapter: PriceAdapter = mode === 'live' ? new YahooChartAdapter('1y') : new FixturePriceAdapter(PRICE_FIXTURES);
  const filingsAdapter: FilingsAdapter = mode === 'live' ? new ScreenerFilingsAdapter() : new FixtureFilingsAdapter(FILINGS_FIXTURES);

  switch (args.command) {
    case 'migrate':
      console.log('Database is at the latest schema.');
      break;

    case 'universe:sync': {
      const u = loadUniverse();
      const t = now().toISOString();
      for (const c of [...u.portfolio, ...u.research]) upsertCompany(db, c, t);
      console.log(`Synced ${u.portfolio.length} portfolio and ${u.research.length} research companies.`);
      break;
    }

    case 'universe:verify': {
      requireLive(mode, args.command);
      const adapter = new YahooChartAdapter('3mo');
      for (const l of listListings(db, { role: args.role ?? undefined })) {
        if (!l.provider_symbol) {
          console.log(`  ${l.id.padEnd(16)} unmapped  no provider ticker known`);
          continue;
        }
        const r = await adapter.fetchDaily(l.provider_symbol, now());
        const t = now().toISOString();
        if (r.status === 'ok' || r.status === 'partial') {
          setListingResolution(db, l.id, r.bars.length > 0 ? 'resolved' : 'unresolved', r.bars.length > 0 ? null : 'no completed sessions', t);
          console.log(`  ${l.provider_symbol.padEnd(16)} resolved  ${r.bars.length} sessions`);
        } else {
          if (r.status === 'unavailable' && r.reason === 'unresolved_symbol') setListingResolution(db, l.id, 'unresolved', r.message, t);
          const detail = 'message' in r ? r.message : '';
          console.log(`  ${l.provider_symbol.padEnd(16)} ${r.status === 'unavailable' ? r.reason : r.status}  ${detail}`);
        }
        await sleep(POLITE_PAUSE_MS);
      }
      break;
    }

    case 'ingest:prices': {
      const results = await ingestPrices(db, priceAdapter, selectListings(db, args), { now, pauseMs: mode === 'live' ? POLITE_PAUSE_MS : 0, sleep });
      for (const r of results) {
        console.log(`  ${(r.providerSymbol ?? r.listingId).padEnd(16)} ${r.outcome.padEnd(15)} +${r.inserted} ~${r.updated} =${r.unchanged} rejected:${r.rejected}${r.message ? `  (${r.message})` : ''}`);
      }
      break;
    }

    case 'ingest:filings': {
      const results = await ingestFilings(db, filingsAdapter, selectCompanies(db, args), { now, pauseMs: mode === 'live' ? POLITE_PAUSE_MS : 0, sleep });
      for (const r of results) {
        console.log(`  ${r.companyId.padEnd(18)} ${r.outcome.padEnd(15)} new:${r.announcementsInserted} dup:${r.announcementsDuplicate} docs:+${r.documentsRegistered}${r.message ? `  (${r.message})` : ''}${r.warnings.length ? `  warnings: ${r.warnings.join('; ')}` : ''}`);
      }
      break;
    }

    case 'reextract': {
      const stale = db
        .prepare(`SELECT id, blob_path, extractor_version FROM document_version WHERE extractor_version LIKE 'unpdf%' AND extractor_version != ?`)
        .all(PDF_EXTRACTOR_VERSION) as { id: string; blob_path: string; extractor_version: string }[];
      let done = 0;
      for (const v of stale) {
        const file = path.isAbsolute(v.blob_path) ? v.blob_path : path.join(paths.blobs, v.blob_path);
        let bytes: Buffer;
        try {
          bytes = await readFile(file);
        } catch (e) {
          console.log(`  skipped ${v.id}: stored file unreadable (${e instanceof Error ? e.message : String(e)})`);
          continue;
        }
        saveExtraction(db, v.id, await extractPdf(new Uint8Array(bytes)));
        // New text means new chunks: the index is rebuilt the next time the document is used.
        db.prepare(`UPDATE document_version SET index_status = 'pending' WHERE id = ?`).run(v.id);
        done += 1;
      }
      console.log(`Re-extracted ${done} of ${stale.length} PDF version(s) with ${PDF_EXTRACTOR_VERSION}.`);
      break;
    }

    case 'reclassify': {
      const t = now().toISOString();
      const all = listAnnouncements(db, { from: '0000-01-01', to: '9999-12-31' });
      const tally = new Map<string, number>();
      db.transaction(() => {
        for (const a of all) {
          const c = classifyAnnouncement(a.title);
          saveClassification(db, a.id, c, t);
          const k = c.status === 'matched' ? c.category : `unclassified/${c.status}`;
          tally.set(k, (tally.get(k) ?? 0) + 1);
        }
      })();
      console.log(`Classified ${all.length} announcements with ${CLASSIFIER_VERSION}:`);
      for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n}`);
      break;
    }

    case 'ingest:documents': {
      requireLive(mode, args.command);
      const companyIds = new Set(selectCompanies(db, args).map((c) => c.id));
      // Pending documents, plus earlier failures (usually transient network errors) for another attempt.
      const pending = [...listDocuments(db, { availability: 'pending' }), ...listDocuments(db, { availability: 'failed' })]
        .filter((d) => companyIds.has(d.company_id) && (!args.kinds || args.kinds.includes(d.kind)))
        .slice(0, args.limit);
      console.log(`Processing ${pending.length} pending document(s)…`);
      for (const d of pending) {
        const r = await processDocument(db, d.id, { blobDir: paths.blobs, now });
        console.log(`  ${d.kind.padEnd(26)} ${r.outcome.padEnd(18)} ${r.pageCount ?? '-'}p  ${d.title.slice(0, 70)}${r.message ? `\n      ${r.message}` : ''}`);
        await sleep(POLITE_PAUSE_MS);
      }
      break;
    }

    case 'ingest:results': {
      requireLive(mode, args.command);
      const since = new Date(now().getTime() - RESULTS_LOOKBACK_DAYS * 86_400_000).toISOString();
      const results = await ingestResultsFilings(db, {
        since,
        companyIds: new Set(selectCompanies(db, args).map((c) => c.id)),
        blobDir: paths.blobs,
        now,
        limit: args.limit,
        pauseMs: POLITE_PAUSE_MS,
        sleep,
      });
      console.log(`Results filings from the last ${RESULTS_LOOKBACK_DAYS} days: ${results.length}`);
      for (const r of results) {
        console.log(`  ${r.companyId.padEnd(18)} ${r.outcome.padEnd(15)} facts:${String(r.stored).padEnd(3)} ${r.quarterEnd ?? '-'}  ${r.title.slice(0, 60)}${r.message ? `\n      ${r.message.slice(0, 160)}` : ''}`);
      }
      break;
    }

    case 'capture:fixtures': {
      requireLive(mode, args.command);
      await mkdir(PRICE_FIXTURES, { recursive: true });
      await mkdir(FILINGS_FIXTURES, { recursive: true });
      for (const l of selectListings(db, args)) {
        if (!l.provider_symbol) continue;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(l.provider_symbol)}?range=1y&interval=1d&includeAdjustedClose=true`;
        const res = await httpGet(url, { accept: 'application/json', passStatuses: [404] }, defaultHttpDeps);
        if (res.ok && res.value.status === 200) {
          const file = path.join(PRICE_FIXTURES, `${l.provider_symbol}.json`);
          await writeFile(file, JSON.stringify({ capturedAt: now().toISOString(), source: 'yahoo', response: JSON.parse(res.value.body.toString('utf8')) as unknown }));
          console.log(`  recorded prices ${l.provider_symbol}`);
        } else {
          console.log(`  could not record prices ${l.provider_symbol}: ${res.ok ? `HTTP ${res.value.status}` : res.error.kind}`);
        }
        await sleep(POLITE_PAUSE_MS);
      }
      const screener = new ScreenerFilingsAdapter();
      for (const c of selectCompanies(db, args)) {
        const r = await screener.fetchCompany({ companyId: c.id, nseSymbol: c.nseSymbol, bseCode: c.bseCode }, now());
        if (r.status === 'ok' || r.status === 'partial') {
          const rec: RecordedFilings = { capturedAt: r.fetchedAt, source: 'screener', pageUrl: r.pageUrl, announcements: r.announcements, documents: r.documents };
          await writeFile(path.join(FILINGS_FIXTURES, fixtureFileName(c.id)), JSON.stringify(rec, null, 1));
          console.log(`  recorded filings ${c.id} (${r.announcements.length} announcements, ${r.documents.length} documents)`);
        } else {
          console.log(`  could not record filings ${c.id}: ${'message' in r ? r.message : r.status}`);
        }
        await sleep(POLITE_PAUSE_MS);
      }
      break;
    }

    case 'status': {
      const t = now();
      console.log('\nPrices (end-of-day; never real-time)');
      for (const l of selectListings(db, args)) {
        const latest = latestTradeDate(db, l.id);
        const f = l.provider_symbol ? lastFetch(db, priceRequestKey(l.provider_symbol)) : null;
        const status = marketDataStatus({ latestTradeDate: latest, lastAttemptOk: f ? f.status === 'ok' || f.status === 'partial' : null, now: t });
        console.log(`  ${(l.provider_symbol ?? l.id).padEnd(16)} ${(latest ?? '—').padEnd(11)} ${MARKET_DATA_STATUS_LABEL[status].padEnd(38)} listing:${l.resolution_status}${f?.data_mode === 'fixture' ? '  [DEMO DATA]' : ''}`);
      }
      console.log('\nFilings');
      for (const c of selectCompanies(db, args)) {
        const f = lastFetch(db, filingsRequestKey(c.id));
        console.log(`  ${c.id.padEnd(18)} ${f ? `${f.status ?? 'running'} at ${f.finished_at ?? f.started_at}${f.data_mode === 'fixture' ? ' [DEMO DATA]' : ''}` : 'never fetched'}${f?.error_message ? `  (${f.error_message.slice(0, 80)})` : ''}`);
      }
      const docs = listDocuments(db);
      const byKey = new Map<string, number>();
      for (const d of docs) byKey.set(`${d.origin}/${d.availability}`, (byKey.get(`${d.origin}/${d.availability}`) ?? 0) + 1);
      console.log('\nDocuments (origin/availability)');
      for (const [k, n] of [...byKey.entries()].sort()) console.log(`  ${k.padEnd(40)} ${n}`);
      break;
    }

    case 'brief': {
      const d = getDigest(db, { window: args.window, now: windowNow(), dataMode: mode });
      if (!d.ok) throw new Error(d.error);
      const c = d.value.counts;
      console.log(`${d.value.window.label}: ${c.high} high, ${c.medium} medium, ${c.low} low, ${c.routineCollapsed} routine collapsed, ${c.duplicatesSuppressed} duplicate(s) merged`);
      for (const g of d.value.groups) {
        for (const it of g.items) {
          console.log(`  [${it.signal.tier.padEnd(6)}] ${g.symbol.padEnd(11)} ${it.signal.kind.padEnd(12)} ${it.signal.headline.slice(0, 80)}${it.alerted ? '  (alerted)' : ''}`);
          console.log(`           ${it.signal.explanation.rules.join(', ')}`);
        }
        if (g.routine.length) console.log(`  [routine] ${g.symbol.padEnd(11)} ${g.routine.length} routine filing(s) collapsed`);
      }
      if (!d.value.groups.length) console.log(`  Nothing in this window.${d.value.latestBefore ? ` Latest before: ${d.value.latestBefore.companyName} "${d.value.latestBefore.headline}" (${d.value.latestBefore.occurredAt})` : ''}`);
      if (d.value.notes.length) console.log(`  ${d.value.notes.length} data note(s), e.g. ${d.value.notes[0]}`);
      break;
    }

    case 'alerts:evaluate': {
      const r = evaluateAlerts(db, { now: windowNow(), dataMode: mode });
      console.log(`Evaluated ${r.rules} enabled rule(s) over events since ${r.since}: ${r.created.length} new alert(s), ${r.skippedDuplicates} already alerted.`);
      for (const a of r.created) console.log(`  ${a.ruleName.padEnd(40)} ${a.signal.symbol.padEnd(11)} ${a.signal.headline.slice(0, 70)}`);
      break;
    }

    case 'research': {
      const ticker = args.symbols?.[0];
      if (!ticker) throw new Error('research needs --symbols TICKER');
      if (args.record) requireLive(mode, 'research --record');
      const request = ResearchRequestSchema.parse({ ticker, question: args.question, period: args.period });
      const llm = createLlmClient(db);
      console.log(`Model: ${llm.describe()}`);
      const resolved = await resolveCompany(db, request.ticker, { allowLiveVerification: mode === 'live', now });
      if (!resolved.ok) {
        console.log(`Cannot research "${ticker}": ${resolved.error.message}`);
        if (resolved.error.kind === 'ambiguous') for (const c of resolved.error.candidates) console.log(`  ${c.nseSymbol ?? c.id}  ${c.name}`);
        process.exitCode = 2;
        break;
      }
      const { report, cached } = await runResearch(resolved.value, request, {
        db,
        llm,
        dataMode: mode,
        blobDir: paths.blobs,
        now,
        filings: mode === 'live' ? new ScreenerFilingsAdapter() : undefined,
        log: (l) => console.log(l),
      });
      console.log(`
${report.company.name} — ${report.status}${cached ? ' (cached report)' : ''}`);
      for (const s of report.sources) console.log(`  source ${s.state.padEnd(18)} ${s.kind.padEnd(26)} ${s.title.slice(0, 60)}${s.detail ? `  (${s.detail.slice(0, 80)})` : ''}`);
      for (const [name, m] of Object.entries(report.modules)) console.log(`  ${name.padEnd(13)} ${m.status.padEnd(12)} ${m.note ?? ''}`);
      console.log(`  evidence items: ${Object.keys(report.evidence).length}; diagnostics: ${report.diagnostics.length}`);
      if (args.record) {
        // A demo report is a real live run, recorded verbatim; its evidence links point at the original filings.
        const file = path.join(RESEARCH_FIXTURES, `${report.company.id.replace(/[^a-z0-9]+/gi, '_')}.json`);
        await mkdir(RESEARCH_FIXTURES, { recursive: true });
        await writeFile(file, `${JSON.stringify({ recordedAt: report.generatedAt, source: 'finn-live-research', report }, null, 1)}\n`);
        console.log(`  recorded demo report: ${path.relative(process.cwd(), file)}`);
      }
      break;
    }

    default:
      console.log('Commands: migrate, universe:sync, universe:verify, ingest:prices, ingest:filings, reclassify, reextract, ingest:documents, ingest:results, capture:fixtures, status, brief, alerts:evaluate, research');
  }
  db.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
});
