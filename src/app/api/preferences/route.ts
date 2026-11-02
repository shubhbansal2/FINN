import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { setPreference } from '@/db/repositories';
import { databaseError, readJson } from '@/server/http';
import { runtime as finnRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only these keys can be written; each value is validated against its own schema. */
const PreferenceSchema = z.discriminatedUnion('key', [z.object({ key: z.literal('signals.window'), value: z.enum(['24h', '3d', '7d', '30d']) })]);

/** PUT /api/preferences — save one preference. Shared by everyone using this server (no accounts). */
export async function PUT(req: NextRequest) {
  const body = await readJson(req, PreferenceSchema, 1024);
  if (!body.ok) return body.response;
  try {
    setPreference(finnRuntime().db, body.data.key, body.data.value, new Date().toISOString());
  } catch (e) {
    return databaseError('Saving the preference', e);
  }
  return NextResponse.json({ saved: body.data });
}
