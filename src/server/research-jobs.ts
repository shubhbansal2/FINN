import 'server-only';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { ScreenerFilingsAdapter } from '@/data/filings/screener';
import type { CompanyRow } from '@/db/repositories';
import { runResearch, type ResearchStage } from '@/research/engine';
import { ResearchReportSchema, type ResearchReport, type ResearchRequest } from '@/research/report';

import { runtime } from './runtime';

/**
 * In-process research jobs. A POST starts one and returns at once; the client
 * polls for stage, per-source progress and, only when finished, the report.
 * Limitation: jobs live in this server process (lost on restart; single host).
 */

export type JobStatus = 'running' | 'complete' | 'partial' | 'failed';

export type ResearchJob = {
  id: string;
  company: { id: string; name: string; symbol: string };
  status: JobStatus;
  stage: ResearchStage | null;
  log: { at: string; stage: ResearchStage; message: string }[];
  sources: ResearchReport['sources'];
  report: ResearchReport | null;
  cached: boolean;
  demo: { recordedAt: string } | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

const MAX_JOBS = 50;
/** Research downloads large documents and may call a paid model; at most this many run at once on this host. */
export const MAX_RUNNING = 2;
const g = globalThis as typeof globalThis & { __finnJobs?: Map<string, ResearchJob> };
const jobs = (g.__finnJobs ??= new Map<string, ResearchJob>());

function remember(job: ResearchJob) {
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (!oldest) break;
    jobs.delete(oldest.id);
  }
}

export function getJob(id: string): ResearchJob | null {
  return jobs.get(id) ?? null;
}

const companyRef = (c: CompanyRow) => ({ id: c.id, name: c.name, symbol: c.nseSymbol ?? c.bseCode ?? c.id });

/** Starts live research, returns the job already running for this company, or null when the host is at capacity. */
export function startResearchJob(company: CompanyRow, request: ResearchRequest): ResearchJob | null {
  const active = [...jobs.values()].filter((j) => j.status === 'running');
  const running = active.find((j) => j.company.id === company.id);
  if (running) return running;
  if (active.length >= MAX_RUNNING) return null;
  const rt = runtime();
  const job: ResearchJob = {
    id: randomUUID(),
    company: companyRef(company),
    status: 'running',
    stage: null,
    log: [],
    sources: [],
    report: null,
    cached: false,
    demo: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  remember(job);
  void runResearch(company, request, {
    db: rt.db,
    llm: rt.llm,
    dataMode: rt.mode,
    blobDir: rt.blobDir,
    now: () => new Date(),
    filings: rt.mode === 'live' ? new ScreenerFilingsAdapter() : undefined,
    onProgress: (e) => {
      if (e.type === 'stage') {
        job.stage = e.stage;
        job.log.push({ at: new Date().toISOString(), stage: e.stage, message: e.message });
      } else {
        job.sources.push(e.source);
      }
    },
  })
    .then((r) => {
      job.report = r.report;
      job.cached = r.cached;
      job.sources = r.report.sources;
      job.status = r.report.status === 'complete' ? 'complete' : 'partial';
    })
    .catch((e: unknown) => {
      console.error('research job failed', e);
      job.status = 'failed';
      job.error = 'Research failed unexpectedly. The error has been logged; sources retrieved so far are listed.';
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });
  return job;
}

const RecordedReport = z.object({ recordedAt: z.string(), source: z.literal('finn-live-research'), report: z.unknown() });

/**
 * Demo mode: a report recorded from a real live run, served as a finished job
 * and labelled as demo data. Its evidence points at the original exchange
 * documents, so every figure and quote remains verifiable.
 */
export async function demoResearchJob(company: CompanyRow): Promise<ResearchJob | null> {
  const file = path.join(process.cwd(), 'fixtures', 'research', `${company.id.replace(/[^a-z0-9]+/gi, '_')}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    // No recording for this company: the caller reports that demo research is unavailable.
    return null;
  }
  const rec = RecordedReport.safeParse(JSON.parse(raw));
  if (!rec.success) return null;
  const report = ResearchReportSchema.safeParse(rec.data.report);
  if (!report.success) return null;
  const demoReport: ResearchReport = { ...report.data, dataMode: 'fixture' };
  const now = new Date().toISOString();
  const job: ResearchJob = {
    id: randomUUID(),
    company: companyRef(company),
    status: demoReport.status === 'complete' ? 'complete' : 'partial',
    stage: 'analysing',
    log: [{ at: now, stage: 'analysing', message: `Recorded report from a live run on ${rec.data.recordedAt}` }],
    sources: demoReport.sources,
    report: demoReport,
    // A recording is not a cache hit; the demo banner says what it is.
    cached: false,
    demo: { recordedAt: rec.data.recordedAt },
    error: null,
    startedAt: now,
    finishedAt: now,
  };
  remember(job);
  return job;
}

/** What the client receives: the report only once the job has finished. */
export function jobView(job: ResearchJob) {
  return { ...job, report: job.status === 'running' ? null : job.report };
}
