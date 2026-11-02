import * as z from 'zod/v4';

import type { Db } from '@/db/connection';

import { runWithCache, type LlmClient, type LlmRequest, type LlmResult, type ModelConfig, type ProviderReply, type Usage } from './core';

/**
 * Google Gemini via the generateContent REST endpoint (free tier on AI Studio).
 * The key travels in the `x-goog-api-key` header, never in the URL, so it
 * cannot leak into logs. Output is constrained to the request's JSON Schema and
 * re-validated by `runWithCache`.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** finishReason values that mean the model declined or was stopped by a policy filter. */
const DECLINED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE']);
/** Statuses worth retrying: rate limits (free-tier quotas) and transient server errors. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRIES = 2;

const GeminiResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })).optional() }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z.object({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional(), thoughtsTokenCount: z.number().optional() }).optional(),
  modelVersion: z.string().optional(),
});

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Capacity problems, after retries: worth trying another model. Bad requests and auth errors are not. */
const overloaded = (r: ProviderReply): r is Extract<ProviderReply, { kind: 'error' }> =>
  r.kind === 'error' && (r.status === 503 || r.status === 429 || r.message.startsWith('timeout:'));

type Options = { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; timeoutMs?: number };

/** Standard JSON Schema for the request, minus the `$schema` marker Gemini does not use. */
function jsonSchemaFor(schema: z.ZodType<unknown>): Record<string, unknown> {
  const { $schema: _marker, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void _marker;
  return rest;
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; status?: string } } | null;
  const detail = body?.error ? `${body.error.status ?? ''} ${body.error.message ?? ''}`.trim() : res.statusText;
  if (res.status === 429) return `429: Gemini rate limit reached (free-tier quota per minute or per day). ${detail}`.trim();
  return `${res.status}: ${detail}`.slice(0, 400);
}

export class GeminiLlmClient implements LlmClient {
  readonly configured = true;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Db,
    private readonly apiKey: string,
    private readonly models: ModelConfig,
    opts: Options = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  describe() {
    return `gemini · extraction: ${this.models.extraction}; synthesis: ${this.models.synthesis}`;
  }

  run<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const model = req.tier === 'extraction' ? this.models.extraction : this.models.synthesis;
    // Free-tier models are sometimes overloaded; synthesis then falls back to the lighter extraction model.
    const fallback = req.tier === 'synthesis' && this.models.extraction !== model ? this.models.extraction : null;
    return runWithCache(this.db, req, model, async () => {
      const first = await this.attempt(model, req);
      if (!fallback || !overloaded(first)) return first;
      const second = await this.attempt(fallback, req);
      if (second.kind === 'error') return { ...first, message: `${first.message}; fallback ${fallback} also failed: ${second.message}` };
      return second.kind === 'text' ? { ...second, fallbackFrom: model } : second;
    });
  }

  private async attempt<T>(model: string, req: LlmRequest<T>): Promise<ProviderReply> {
    const first = await this.call(model, req, true);
    // A schema Gemini finds too complex is rejected with 400; retry once with the schema written into the instructions.
    if (first.kind === 'error' && first.status === 400 && /schema/i.test(first.message)) return this.call(model, req, false);
    return first;
  }

  private async call<T>(model: string, req: LlmRequest<T>, constrained: boolean): Promise<ProviderReply> {
    const schema = jsonSchemaFor(req.schema as z.ZodType<unknown>);
    const system = constrained ? req.system : `${req.system}\n\nRespond with JSON only, matching this JSON Schema exactly:\n${JSON.stringify(schema)}`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: req.input }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        ...(constrained ? { responseJsonSchema: schema } : {}),
        // Thinking tokens count toward this limit, so leave room beyond the answer itself.
        maxOutputTokens: req.maxTokens ?? 16_000,
        thinkingConfig: { thinkingLevel: req.tier === 'extraction' ? 'LOW' : 'HIGH' },
      },
    };
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

    let res: Response | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        // A request that hangs until the timeout usually means the model is overloaded; retrying
        // only multiplies the wait, so a timeout fails at once. Connection errors are retried.
        const timedOut = e instanceof Error && (e.name === 'TimeoutError' || /timeout/i.test(e.message));
        if (!timedOut && attempt < RETRIES) {
          await this.sleep(2_000 * 3 ** attempt);
          continue;
        }
        return { kind: 'error', message: timedOut ? `timeout: ${model} gave no response within ${this.timeoutMs / 1_000}s (often high demand on the free tier; try again later or set FINN_GEMINI_MODEL_SYNTHESIS)` : `network: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (RETRYABLE.has(res.status) && attempt < RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1_000 : 2_000 * 3 ** attempt);
        continue;
      }
      break;
    }
    if (!res.ok) return { kind: 'error', status: res.status, message: await errorText(res) };

    const parsed = GeminiResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { kind: 'error', message: 'Gemini returned a response in an unexpected shape' };
    const r = parsed.data;
    const m = r.modelVersion ?? model;
    const u = r.usageMetadata;
    const usage: Usage | null = u ? { input_tokens: u.promptTokenCount ?? 0, output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } : null;

    if (r.promptFeedback?.blockReason) return { kind: 'refused', category: `prompt ${r.promptFeedback.blockReason.toLowerCase()}`, model: m, usage };
    const candidate = r.candidates?.[0];
    if (!candidate) return { kind: 'error', message: 'Gemini returned no candidates' };
    if (candidate.finishReason && DECLINED.has(candidate.finishReason)) return { kind: 'refused', category: candidate.finishReason.toLowerCase(), model: m, usage };
    if (candidate.finishReason === 'MAX_TOKENS') return { kind: 'truncated', model: m, usage };
    // Thought parts carry reasoning, not the answer.
    const text = (candidate.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    return { kind: 'text', text, model: m, usage };
  }
}
