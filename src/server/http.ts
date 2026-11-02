import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import type { z } from 'zod';

export type ApiError = { error: { kind: string; message: string } };

export const apiError = (status: number, kind: string, message: string) => NextResponse.json<ApiError>({ error: { kind, message } }, { status });

/** A failed read or write of the local database: logged server-side, reported to the client by what failed. */
export function databaseError(what: string, e: unknown): NextResponse<ApiError> {
  console.error(`database operation failed: ${what}`, e);
  return apiError(500, 'database', `${what} failed in FINN's local database. Nothing was changed; try again.`);
}

/** Reads a JSON body with a size cap and validates it. Returns the data or a ready error response. */
export async function readJson<T extends z.ZodTypeAny>(req: NextRequest, schema: T, maxBytes = 16 * 1024): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  const raw = await req.text();
  if (raw.length > maxBytes) return { ok: false, response: apiError(413, 'too_large', 'Request body is too large.') };
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, response: apiError(400, 'invalid_json', 'Request body must be JSON.') };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, response: apiError(400, 'invalid_request', parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')) };
  }
  return { ok: true, data: parsed.data };
}
