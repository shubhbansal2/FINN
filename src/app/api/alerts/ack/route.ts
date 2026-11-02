import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { acknowledgeAlerts } from '@/push/store';
import { runtime as finnRuntime } from '@/server/runtime';
import { databaseError, readJson } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

/** POST /api/alerts/ack — mark in-app deliveries as seen. */
export async function POST(req: NextRequest) {
  const body = await readJson(req, Body);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json({ acknowledged: acknowledgeAlerts(finnRuntime().db, body.data.ids, new Date().toISOString()) });
  } catch (e) {
    return databaseError('Marking alerts as seen', e);
  }
}
