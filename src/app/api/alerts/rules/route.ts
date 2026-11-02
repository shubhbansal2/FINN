import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import { RuleInputSchema } from '@/push/rules';
import { listRules, saveRule } from '@/push/store';
import { runtime as finnRuntime } from '@/server/runtime';
import { apiError, databaseError, readJson } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/alerts/rules — persisted alert rules. */
export async function GET() {
  return NextResponse.json({ rules: listRules(finnRuntime().db) });
}

/** POST /api/alerts/rules — create a rule. */
export async function POST(req: NextRequest) {
  const body = await readJson(req, RuleInputSchema);
  if (!body.ok) return body.response;
  try {
    const rule = saveRule(finnRuntime().db, body.data, new Date().toISOString());
    return NextResponse.json({ rule }, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) return apiError(400, 'invalid_request', e.issues.map((i) => i.message).join('; '));
    return databaseError('Saving the rule', e);
  }
}
