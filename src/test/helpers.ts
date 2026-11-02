import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { UniverseCompany } from '@/config/universe';
import type { HttpDeps } from '@/data/http';
import { openDatabase, type Db } from '@/db/connection';
import { upsertCompany } from '@/db/repositories';

export const T0 = '2026-11-01T06:00:00.000Z';

export function memoryDb(): Db {
  return openDatabase(':memory:');
}

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'finn-test-'));
}

export const SPECIMEN: UniverseCompany = {
  id: 'nse:specimen',
  name: 'Specimen Industries',
  sector: 'Test',
  size: 'mid',
  reportingProfile: 'industrial',
  irDomains: ['specimen.example'],
  listings: [
    { exchange: 'NSE', symbol: 'SPECIMEN' },
    { exchange: 'BSE', symbol: '999999', ticker: 'SPECIMEN' },
  ],
  role: 'portfolio',
};

export function seededDb(): Db {
  const db = memoryDb();
  upsertCompany(db, SPECIMEN, T0);
  return db;
}

type Route = { status?: number; body: string | Buffer; contentType?: string } | Error;

/** Fake network: maps URL substrings to responses; records requests. */
export function fakeHttp(routes: Record<string, Route | Route[]>): HttpDeps & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const counters = new Map<string, number>();
  return {
    calls,
    sleep: async () => undefined,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) return new Response('not found', { status: 404 });
      const entry = routes[key];
      if (entry === undefined) return new Response('not found', { status: 404 });
      let route: Route | undefined;
      if (Array.isArray(entry)) {
        const n = counters.get(key) ?? 0;
        counters.set(key, n + 1);
        route = entry[Math.min(n, entry.length - 1)];
      } else {
        route = entry;
      }
      if (!route) return new Response('not found', { status: 404 });
      if (route instanceof Error) throw route;
      const body = typeof route.body === 'string' ? route.body : new Uint8Array(route.body);
      return new Response(body, { status: route.status ?? 200, headers: { 'content-type': route.contentType ?? 'application/json' } });
    }) as typeof fetch,
  };
}

/** A minimal, valid PDF with one text line per page (empty string = page with no text). */
export function makePdf(pages: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const pid = 4 + i * 2;
    const stream = text ? `BT /F1 10 Tf 40 720 Td (${esc(text)}) Tj ET` : '';
    objects[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pid + 1} 0 R >>`;
    objects[pid + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Yahoo chart JSON for given IST dates (bar timestamps at 09:15 IST). */
export function yahooChart(symbol: string, rows: { date: string; o: number | null; h: number | null; l: number | null; c: number | null; v: number | null }[], currency = 'INR') {
  const ts = rows.map((r) => Date.parse(`${r.date}T03:45:00Z`) / 1000);
  return {
    chart: {
      result: [
        {
          meta: { currency, symbol, exchangeTimezoneName: 'Asia/Kolkata' },
          timestamp: ts,
          indicators: {
            quote: [{ open: rows.map((r) => r.o), high: rows.map((r) => r.h), low: rows.map((r) => r.l), close: rows.map((r) => r.c), volume: rows.map((r) => r.v) }],
            adjclose: [{ adjclose: rows.map((r) => r.c) }],
          },
        },
      ],
      error: null,
    },
  };
}
