import { NextResponse, type NextRequest } from 'next/server';

import { latestReport } from '@/research/engine';
import { ResearchRequestSchema } from '@/research/report';
import { resolveCompany } from '@/research/resolve';
import { demoResearchJob, jobView, MAX_RUNNING, startResearchJob } from '@/server/research-jobs';
import { allow, runtime as finnRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;

type ErrorBody = { error: { kind: string; message: string; candidates?: { id: string; name: string; nseSymbol: string | null }[] } };
const fail = (status: number, kind: string, message: string, extra: Partial<ErrorBody['error']> = {}) => NextResponse.json<ErrorBody>({ error: { kind, message, ...extra } }, { status });

// x-forwarded-for can be set by any client, so the per-client limit is backed by a global one below.
const clientKey = (req: NextRequest) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';

/**
 * POST /api/research — resolve the company, then start research.
 * Returns 202 with a job id at once; poll GET /api/research/jobs/:id.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, 'too_large', 'Request body is too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'invalid_json', 'Request body must be JSON.');
  }
  const parsed = ResearchRequestSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '));
  if (!allow(`research:${clientKey(req)}`, 12, 60 * 60 * 1000)) return fail(429, 'rate_limited', 'Too many research requests from this client; try again later.');
  if (!allow('research:all', 40, 60 * 60 * 1000)) return fail(429, 'rate_limited', 'This server has run its hourly allowance of research requests; try again later.');

  const rt = finnRuntime();
  const resolved = await resolveCompany(rt.db, parsed.data.ticker, { allowLiveVerification: rt.mode === 'live', now: () => new Date() });
  if (!resolved.ok) {
    const status = resolved.error.kind === 'ambiguous' ? 409 : resolved.error.kind === 'invalid_input' ? 400 : resolved.error.kind === 'unverifiable' ? 503 : 404;
    return fail(status, resolved.error.kind, resolved.error.message, resolved.error.kind === 'ambiguous' ? { candidates: resolved.error.candidates } : {});
  }

  if (rt.mode === 'fixture') {
    const demo = await demoResearchJob(resolved.value);
    if (!demo) {
      return fail(404, 'no_demo_report', `Demo mode has no recorded report for ${resolved.value.name}. Live research needs FINN_DATA_MODE=live; FINN does not substitute prewritten analysis.`);
    }
    return NextResponse.json({ job: jobView(demo) }, { status: 202 });
  }

  const job = startResearchJob(resolved.value, parsed.data);
  if (!job) return fail(429, 'busy', `Research is already running for ${MAX_RUNNING} companies on this server; try again when one finishes.`);
  return NextResponse.json({ job: jobView(job) }, { status: 202 });
}

/** GET /api/research?ticker=RELIANCE — the latest stored report, without running anything. */
export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker') ?? '';
  const rt = finnRuntime();
  const resolved = await resolveCompany(rt.db, ticker, { allowLiveVerification: false, now: () => new Date() });
  if (!resolved.ok) return fail(resolved.error.kind === 'ambiguous' ? 409 : 404, resolved.error.kind, resolved.error.message);
  const report = latestReport(rt.db, resolved.value.id);
  if (!report) return fail(404, 'no_report', `No research report exists yet for ${resolved.value.name}.`);
  return NextResponse.json({ report, cached: true });
}
