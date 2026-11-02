import path from 'node:path';
import { z } from 'zod';

/**
 * Server-side configuration. Read only from server code and scripts; nothing
 * here is exposed to the browser bundle (no NEXT_PUBLIC_ variables).
 */
const EnvSchema = z.object({
  /**
   * `fixture`: recorded provider responses only; every surface is labelled demo.
   * `live`: real provider calls. The two modes use separate database files so
   * demo and live data can never mix.
   */
  FINN_DATA_MODE: z.enum(['live', 'fixture']).default('fixture'),
  /** Directory for the SQLite database and downloaded documents. Keep it outside cloud-synced folders. */
  FINN_DATA_DIR: z.string().min(1).default('data'),
  FINN_ENABLE_DEV_ROUTES: z.enum(['true', 'false']).default('false'),
  /** Demo mode only: the fixed "now" that signal windows and alert evaluation use. Defaults to when the fixtures were recorded. */
  FINN_DEMO_NOW: z.string().datetime().default('2026-11-01T10:30:00.000Z'),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  override name = 'EnvError';
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export function dataPaths(env: Env) {
  const root = path.resolve(env.FINN_DATA_DIR);
  return {
    root,
    database: path.join(root, `finn-${env.FINN_DATA_MODE}.sqlite`),
    blobs: path.join(root, 'blobs'),
  };
}
