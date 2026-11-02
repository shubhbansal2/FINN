import Anthropic from '@anthropic-ai/sdk';
import * as z from 'zod/v4';

import type { Db } from '@/db/connection';

import { runWithCache, type LlmClient, type LlmRequest, type LlmResult, type ModelConfig, type ProviderReply } from './core';

/** Models with server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

/** The subset of the SDK this client uses; lets tests substitute a fake transport. */
export type MessagesTransport = Pick<Anthropic['beta']['messages'], 'create'>;

/** Claude via the Anthropic SDK (SDK retries: 2, on 408/409/429/5xx). */
export class AnthropicLlmClient implements LlmClient {
  readonly configured = true;

  constructor(
    private readonly db: Db,
    private readonly models: ModelConfig,
    private readonly transport: MessagesTransport = new Anthropic({ maxRetries: 2, timeout: 120_000 }).beta.messages,
  ) {}

  describe() {
    return `anthropic · extraction: ${this.models.extraction}; synthesis: ${this.models.synthesis}`;
  }

  run<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const model = req.tier === 'extraction' ? this.models.extraction : this.models.synthesis;
    return runWithCache(this.db, req, model, () => this.call(model, req));
  }

  private async call<T>(model: string, req: LlmRequest<T>): Promise<ProviderReply> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.transport.create({
        model,
        max_tokens: req.maxTokens ?? 8_000,
        system: req.system,
        messages: [{ role: 'user', content: req.input }],
        output_config: {
          format: { type: 'json_schema', schema: z.toJSONSchema(req.schema) as Record<string, unknown> },
          effort: req.tier === 'extraction' ? 'low' : 'high',
        },
        ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
    } catch (e) {
      const message = e instanceof Anthropic.APIError ? `${e.status ?? 'network'}: ${e.message}` : e instanceof Error ? e.message : String(e);
      return { kind: 'error', message };
    }
    const usage = response.usage ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } : null;
    if (response.stop_reason === 'refusal') return { kind: 'refused', category: response.stop_details?.category ?? 'unspecified', model: response.model, usage };
    if (response.stop_reason === 'max_tokens') return { kind: 'truncated', model: response.model, usage };
    return { kind: 'text', text: response.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), model: response.model, usage };
  }
}
