import { NextResponse, type NextRequest } from 'next/server';

import { RuleInputSchema } from '@/push/rules';
import { deleteRule, getRule, saveRule } from '@/push/store';
import { runtime as finnRuntime } from '@/server/runtime';
import { apiError, databaseError, readJson } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** PUT /api/alerts/rules/:id — replace a rule; its version increments. Past alerts are unaffected. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const db = finnRuntime().db;
  if (!getRule(db, id)) return apiError(404, 'not_found', 'No such rule.');
  const body = await readJson(req, RuleInputSchema);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json({ rule: saveRule(db, body.data, new Date().toISOString(), id) });
  } catch (e) {
    return databaseError('Saving the rule', e);
  }
}

/** DELETE /api/alerts/rules/:id — delete a rule. Alerts it already produced are kept. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    return deleteRule(finnRuntime().db, id) ? NextResponse.json({ deleted: id }) : apiError(404, 'not_found', 'No such rule.');
  } catch (e) {
    return databaseError('Deleting the rule', e);
  }
}
