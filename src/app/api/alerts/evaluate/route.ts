import { NextResponse } from 'next/server';

import { evaluateAlerts } from '@/push/service';
import { allow, runtime as finnRuntime } from '@/server/runtime';
import { apiError, databaseError } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/alerts/evaluate — evaluate enabled rules now. Idempotent: already-alerted events are skipped. */
export async function POST() {
  if (!allow('alerts:evaluate', 30, 60_000)) return apiError(429, 'rate_limited', 'Evaluation was requested too often; wait a moment.');
  const rt = finnRuntime();
  let r: ReturnType<typeof evaluateAlerts>;
  try {
    r = evaluateAlerts(rt.db, { now: rt.clock(), dataMode: rt.mode });
  } catch (e) {
    return databaseError('Evaluating alert rules', e);
  }
  return NextResponse.json({ evaluatedAt: r.evaluatedAt, rules: r.rules, created: r.created.length, skippedDuplicates: r.skippedDuplicates });
}
