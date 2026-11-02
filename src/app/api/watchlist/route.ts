import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { addToWatchlist, ensureWatchlist, removeFromWatchlist, watchlistIds } from '@/db/repositories';
import { apiError, databaseError, readJson } from '@/server/http';
import { runtime as finnRuntime } from '@/server/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChangeSchema = z.object({ action: z.enum(['add', 'remove']), companyId: z.string().trim().min(1).max(80) });

/** GET /api/watchlist — company ids on the watchlist. */
export async function GET() {
  const { db } = finnRuntime();
  ensureWatchlist(db, new Date().toISOString());
  return NextResponse.json({ companyIds: watchlistIds(db) });
}

/** POST /api/watchlist — add or remove one known company. The watchlist is shared by everyone using this server. */
export async function POST(req: NextRequest) {
  const body = await readJson(req, ChangeSchema, 1024);
  if (!body.ok) return body.response;
  const { db } = finnRuntime();
  const now = new Date().toISOString();
  try {
    ensureWatchlist(db, now);
    if (body.data.action === 'add') {
      if (!addToWatchlist(db, body.data.companyId, now)) return apiError(404, 'not_found', 'No company with that id is known to FINN. Research it first so it can be verified.');
    } else {
      removeFromWatchlist(db, body.data.companyId);
    }
  } catch (e) {
    return databaseError('Updating the watchlist', e);
  }
  return NextResponse.json({ companyIds: watchlistIds(db) });
}
