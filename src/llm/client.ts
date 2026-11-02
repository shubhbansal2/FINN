import type { Db } from '@/db/connection';

import { AnthropicLlmClient } from './anthropic';
import { UnconfiguredLlmClient, type LlmClient } from './core';
import { GeminiLlmClient } from './gemini';

export { AnthropicLlmClient, type MessagesTransport } from './anthropic';
export { cacheKey, UnconfiguredLlmClient, type LlmClient, type LlmRequest, type LlmResult, type ModelConfig, type ModelTier } from './core';
export { GeminiLlmClient } from './gemini';

/**
 * Builds the configured client. Credentials are read only on the server, from the environment.
 * FINN_LLM_PROVIDER: `gemini`, `anthropic`, or `auto` (default: Anthropic if its key is set, else Gemini if its key is set).
 */
export function createLlmClient(db: Db, env: Readonly<Record<string, string | undefined>> = process.env): LlmClient {
  const provider = (env.FINN_LLM_PROVIDER || 'auto').toLowerCase();
  const anthropicKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!['auto', 'gemini', 'anthropic'].includes(provider)) return new UnconfiguredLlmClient(`unknown FINN_LLM_PROVIDER "${provider}" (use gemini, anthropic or auto); model-assisted modules are off`);

  if (provider === 'gemini' || (provider === 'auto' && !anthropicKey && geminiKey)) {
    if (!geminiKey) return new UnconfiguredLlmClient('FINN_LLM_PROVIDER=gemini but GEMINI_API_KEY is not set; model-assisted modules are off');
    return new GeminiLlmClient(db, geminiKey, {
      extraction: env.FINN_GEMINI_MODEL_EXTRACTION || 'gemini-3.5-flash-lite',
      // gemini-3.8-flash is newer but was overloaded (503 / no response) when tested on 2 Nov 2026; 3.6 answered in seconds.
      synthesis: env.FINN_GEMINI_MODEL_SYNTHESIS || 'gemini-3.6-flash',
    });
  }
  if (!anthropicKey) return new UnconfiguredLlmClient(provider === 'anthropic' ? 'FINN_LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set; model-assisted modules are off' : undefined);
  // `new` with no transport argument: the Anthropic SDK reads its key from the environment itself.
  return new AnthropicLlmClient(db, {
    extraction: env.FINN_MODEL_EXTRACTION || 'claude-haiku-5-5',
    synthesis: env.FINN_MODEL_SYNTHESIS || 'claude-opus-5-5',
  });
}
