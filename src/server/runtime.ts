import 'server-only';

import { dataPaths, readEnv } from '@/config/env';
import { openDatabase, type Db } from '@/db/connection';
import { createLlmClient, type LlmClient } from '@/llm/client';

/**
 * Process-wide server resources for route handlers. One database handle per
 * process (cached on globalThis so dev hot-reload does not leak handles).
 * Server-only: importing this from a client component fails the build.
 */
type Runtime = {
  db: Db;
  llm: LlmClient;
  mode: 'live' | 'fixture';
  blobDir: string;
  /**
   * The time windows are measured from. Live: the real clock. Demo: fixed at
   * the fixtures' recording time, so the recorded data does not drift out of
   * every window as days pass; pages label it as a demo clock.
   */
  clock: () => Date;
};

const g = globalThis as typeof globalThis & { __finnRuntime?: Runtime };

export function runtime(): Runtime {
  if (!g.__finnRuntime) {
    const env = readEnv();
    const paths = dataPaths(env);
    const db = openDatabase(paths.database);
    const demoNow = env.FINN_DEMO_NOW;
    g.__finnRuntime = { db, llm: createLlmClient(db), mode: env.FINN_DATA_MODE, blobDir: paths.blobs, clock: env.FINN_DATA_MODE === 'fixture' ? () => new Date(demoNow) : () => new Date() };
  }
  return g.__finnRuntime;
}

/** Small in-memory sliding-window limiter. Per process; sufficient for a single-host prototype. */
const hits = new Map<string, number[]>();
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  // Keys can come from client headers; drop the oldest keys rather than grow without bound.
  if (hits.size > 5_000) for (const k of [...hits.keys()].slice(0, 1_000)) hits.delete(k);
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}
