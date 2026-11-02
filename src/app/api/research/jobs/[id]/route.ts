import { NextResponse, type NextRequest } from 'next/server';

import { getJob, jobView } from '@/server/research-jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/research/jobs/:id — stage, per-source progress, and the report once finished. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: { kind: 'invalid_request', message: 'Malformed job id.' } }, { status: 400 });
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: { kind: 'not_found', message: 'This research job is not known to the server (it may have restarted). Start the research again.' } }, { status: 404 });
  return NextResponse.json({ job: jobView(job) });
}
