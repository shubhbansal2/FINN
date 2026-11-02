import { createHash } from 'node:crypto';
import type * as z from 'zod/v4';

import type { Db } from '@/db/connection';

/**
 * Provider-neutral model access. The rest of FINN sees only `LlmClient`:
 * - structured output against a JSON schema, re-validated with zod;
 * - results cached by (task, prompt version, model, input) — an identical
 *   request never reaches the API twice;
 * - bounded retries, no repair loops;
 * - every call recorded in `llm_call` with model, status and failure reason.
 * The model interprets language. It never does arithmetic that reaches the UI.
 */

export type ModelTier = 'extraction' | 'synthesis';

export type LlmRequest<T> = {
  task: string;
  promptVersion: string;
  tier: ModelTier;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
};

export type LlmResult<T> =
  | { status: 'ok'; output: T; model: string; cached: boolean }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: 'invalid_output' | 'refused' | 'truncated' | 'api_error'; message: string; model: string };

export interface LlmClient {
  readonly configured: boolean;
  /** Human-readable configuration, e.g. "gemini · extraction: gemini-3.5-flash-lite; synthesis: gemini-3.6-flash". */
  describe(): string;
  run<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export type ModelConfig = { extraction: string; synthesis: string };

/** Used when no credentials are configured: every call reports unavailability; nothing is invented. */
export class UnconfiguredLlmClient implements LlmClient {
  readonly configured = false;
  constructor(private readonly reason = 'no model configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY to enable model-assisted modules)') {}
  describe() {
    return this.reason;
  }
  async run<T>(): Promise<LlmResult<T>> {
    return { status: 'unavailable', reason: 'no model configured' };
  }
}

export function cacheKey(req: Pick<LlmRequest<unknown>, 'task' | 'promptVersion' | 'system' | 'input'>, model: string): string {
  return createHash('sha256').update([req.task, req.promptVersion, model, req.system, req.input].join('\u0000')).digest('hex');
}

export type Usage = { input_tokens: number; output_tokens: number };

/** What a provider adapter reports for one call, before FINN validates anything. */
export type ProviderReply =
  /** `fallbackFrom`: the requested model was unavailable and `model` answered instead. */
  | { kind: 'text'; text: string; model: string; usage: Usage | null; fallbackFrom?: string }
  | { kind: 'refused'; category: string; model: string; usage: Usage | null }
  | { kind: 'truncated'; model: string; usage: Usage | null }
  | { kind: 'error'; message: string; status?: number };

/**
 * The shared path for every provider: serve from cache, otherwise call once,
 * then accept only output that parses as JSON and passes the request's schema.
 * Each outcome is recorded in `llm_call`.
 */
export async function runWithCache<T>(db: Db, req: LlmRequest<T>, model: string, call: () => Promise<ProviderReply>): Promise<LlmResult<T>> {
  const key = cacheKey(req, model);
  // Answers from a fallback model are logged with a note (error is not null) and never served from cache,
  // so the next run tries the requested model again.
  const cached = db.prepare(`SELECT output FROM llm_call WHERE cache_key = ? AND status = 'ok' AND error IS NULL`).get(key) as { output: string } | undefined;
  if (cached) {
    const parsed = req.schema.safeParse(JSON.parse(cached.output));
    if (parsed.success) return { status: 'ok', output: parsed.data, model, cached: true };
  }

  const record = (status: 'ok' | 'invalid_output' | 'refused' | 'error', output: unknown, error: string | null, usage: Usage | null) =>
    db
      .prepare(
        `INSERT INTO llm_call (cache_key, task, prompt_version, model, status, output, error, input_tokens, output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET status = excluded.status, output = excluded.output, error = excluded.error,
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, created_at = excluded.created_at`,
      )
      .run(key, req.task, req.promptVersion, model, status, output === null ? null : JSON.stringify(output), error, usage?.input_tokens ?? null, usage?.output_tokens ?? null, new Date().toISOString());

  const reply = await call();
  if (reply.kind === 'error') {
    record('error', null, reply.message.slice(0, 500), null);
    return { status: 'failed', reason: 'api_error', message: reply.message, model };
  }
  if (reply.kind === 'refused') {
    record('refused', null, reply.category, reply.usage);
    return { status: 'failed', reason: 'refused', message: `model declined (${reply.category})`, model: reply.model };
  }
  if (reply.kind === 'truncated') {
    record('invalid_output', null, 'truncated at max_tokens', reply.usage);
    return { status: 'failed', reason: 'truncated', message: 'output truncated at max_tokens', model: reply.model };
  }
  let json: unknown;
  try {
    json = JSON.parse(reply.text);
  } catch {
    record('invalid_output', null, 'response was not JSON', reply.usage);
    return { status: 'failed', reason: 'invalid_output', message: 'response was not JSON', model: reply.model };
  }
  const parsed = req.schema.safeParse(json);
  if (!parsed.success) {
    const message = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    record('invalid_output', null, message, reply.usage);
    return { status: 'failed', reason: 'invalid_output', message, model: reply.model };
  }
  record('ok', parsed.data, reply.fallbackFrom ? `fallback: ${reply.fallbackFrom} unavailable, answered by ${reply.model}` : null, reply.usage);
  return { status: 'ok', output: parsed.data, model: reply.model, cached: false };
}
