// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { openDatabase } from '@/db/connection';

import { createLlmClient, GeminiLlmClient } from './client';

const schema = z.strictObject({ answer: z.string() });
const req = { task: 't', promptVersion: 'v1', tier: 'synthesis' as const, system: 'sys', input: 'in', schema };
const models = { extraction: 'gemini-3.5-flash-lite', synthesis: 'gemini-3.8-flash' };

const ok = (text: string, over: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 30 },
  modelVersion: 'gemini-3.8-flash',
  ...over,
});

type Sent = { url: string; headers: Record<string, string>; body: { systemInstruction: { parts: { text: string }[] }; generationConfig: Record<string, unknown> } };

/** A fake fetch that replays responses in order and records what was sent. */
function fakeFetch(replies: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const sent: Sent[] = [];
  let n = 0;
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Sent['body'] });
    const r = replies[Math.min(n++, replies.length - 1)];
    if (!r) throw new Error('no reply configured');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { fetch, sent };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => void sleeps.push(ms);

describe('GeminiLlmClient', () => {
  it('sends the key in a header, constrains output to the schema, ignores thought parts and caches the result', async () => {
    const db = openDatabase(':memory:');
    const f = fakeFetch([{ status: 200, body: ok('{"answer":"yes"}') }]);
    const client = new GeminiLlmClient(db, 'secret-key', models, { fetch: f.fetch, sleep });
    expect(await client.run(req)).toEqual({ status: 'ok', output: { answer: 'yes' }, model: 'gemini-3.8-flash', cached: false });
    expect(await client.run(req)).toMatchObject({ status: 'ok', cached: true });
    expect(f.sent).toHaveLength(1);
    const [call] = f.sent;
    expect(call?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(call?.url).not.toContain('secret-key');
    expect(call?.headers['x-goog-api-key']).toBe('secret-key');
    expect(call?.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'HIGH' }, maxOutputTokens: 16_000 });
    expect(call?.body.generationConfig.responseJsonSchema).toMatchObject({ type: 'object', required: ['answer'], additionalProperties: false });
    expect(call?.body.generationConfig.responseJsonSchema).not.toHaveProperty('$schema');
    expect(db.prepare(`SELECT status, input_tokens, output_tokens FROM llm_call`).get()).toEqual({ status: 'ok', input_tokens: 12, output_tokens: 35 });
  });

  it('uses the extraction model with low thinking for extraction tasks', async () => {
    const f = fakeFetch([{ status: 200, body: ok('{"answer":"x"}', { modelVersion: 'gemini-3.5-flash-lite' }) }]);
    await new GeminiLlmClient(openDatabase(':memory:'), 'k', models, { fetch: f.fetch, sleep }).run({ ...req, tier: 'extraction' });
    expect(f.sent[0]?.url).toContain('/gemini-3.5-flash-lite:generateContent');
    expect(f.sent[0]?.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  it('reports policy blocks as refusals and MAX_TOKENS as truncation, never as output', async () => {
    const run = (body: unknown, input: string) => new GeminiLlmClient(openDatabase(':memory:'), 'k', models, { fetch: fakeFetch([{ status: 200, body }]).fetch, sleep }).run({ ...req, input });
    expect(await run({ candidates: [{ finishReason: 'SAFETY' }] }, 'a')).toMatchObject({ status: 'failed', reason: 'refused', message: 'model declined (safety)' });
    expect(await run({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'b')).toMatchObject({ status: 'failed', reason: 'refused' });
    expect(await run({ candidates: [{ content: { parts: [{ text: '{"ans' }] }, finishReason: 'MAX_TOKENS' }] }, 'c')).toMatchObject({ status: 'failed', reason: 'truncated' });
    expect(await run(ok('{"wrong":1}'), 'd')).toMatchObject({ status: 'failed', reason: 'invalid_output' });
  });

  it('retries free-tier rate limits with backoff, then reports them plainly', async () => {
    sleeps.length = 0;
    const recovered = fakeFetch([{ status: 429, body: {} }, { status: 503, body: {} }, { status: 200, body: ok('{"answer":"late"}') }]);
    expect(await new GeminiLlmClient(openDatabase(':memory:'), 'k', models, { fetch: recovered.fetch, sleep }).run(req)).toMatchObject({ status: 'ok', output: { answer: 'late' } });
    expect(sleeps).toEqual([2_000, 6_000]);

    const exhausted = fakeFetch([{ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, headers: { 'retry-after': '7' } }]);
    const result = await new GeminiLlmClient(openDatabase(':memory:'), 'k', models, { fetch: exhausted.fetch, sleep }).run({ ...req, tier: 'extraction' });
    expect(exhausted.sent).toHaveLength(3);
    expect(result).toMatchObject({ status: 'failed', reason: 'api_error', message: expect.stringMatching(/rate limit.*RESOURCE_EXHAUSTED Quota exceeded/) });
    expect(sleeps.slice(-2)).toEqual([7_000, 7_000]);
  });

  it('falls back to the extraction model when the synthesis model is overloaded, without caching the fallback answer', async () => {
    const db = openDatabase(':memory:');
    const busy = { status: 503, body: { error: { status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } } };
    const f = fakeFetch([busy, busy, busy, { status: 200, body: ok('{"answer":"from lite"}', { modelVersion: 'gemini-3.5-flash-lite' }) }]);
    const client = new GeminiLlmClient(db, 'k', models, { fetch: f.fetch, sleep });
    expect(await client.run(req)).toEqual({ status: 'ok', output: { answer: 'from lite' }, model: 'gemini-3.5-flash-lite', cached: false });
    expect(f.sent.map((s) => s.url.split('/').pop())).toEqual([...Array(3).fill('gemini-3.8-flash:generateContent'), 'gemini-3.5-flash-lite:generateContent']);
    expect(db.prepare(`SELECT status, error FROM llm_call`).get()).toEqual({ status: 'ok', error: 'fallback: gemini-3.8-flash unavailable, answered by gemini-3.5-flash-lite' });
    // Not served from cache: the next run tries the requested model again.
    await client.run(req);
    expect(f.sent.length).toBeGreaterThan(4);

    const allDown = fakeFetch([busy]);
    expect(await new GeminiLlmClient(openDatabase(':memory:'), 'k', models, { fetch: allDown.fetch, sleep }).run(req)).toMatchObject({
      status: 'failed',
      reason: 'api_error',
      message: expect.stringMatching(/^503: .*high demand.*; fallback gemini-3\.5-flash-lite also failed: 503/),
    });
  });

  it('does not retry a request that timed out (an overloaded model), but does retry connection errors', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    let calls = 0;
    const hung = async () => {
      calls += 1;
      throw timeout;
    };
    const result = await new GeminiLlmClient(openDatabase(':memory:'), 'k', models, { fetch: hung, sleep }).run({ ...req, tier: 'extraction' });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'failed', reason: 'api_error', message: expect.stringMatching(/^timeout: gemini-3\.5-flash-lite gave no response within 120s/) });

    calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 2) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(ok('{"answer":"ok"}')), { status: 200 });
    };
    expect(await new GeminiLlmClient(openDatabase(':memory:'), 'k', models, { fetch: flaky, sleep }).run({ ...req, input: 'flaky' })).toMatchObject({ status: 'ok' });
    expect(calls).toBe(2);
  });

  it('falls back to schema-in-instructions once when Gemini rejects the schema', async () => {
    const f = fakeFetch([{ status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'schema is too complex' } } }, { status: 200, body: ok('{"answer":"ok"}') }]);
    expect(await new GeminiLlmClient(openDatabase(':memory:'), 'k', models, { fetch: f.fetch, sleep }).run(req)).toMatchObject({ status: 'ok' });
    expect(f.sent[1]?.body.generationConfig).not.toHaveProperty('responseJsonSchema');
    expect(f.sent[1]?.body.systemInstruction.parts[0]?.text).toContain('matching this JSON Schema');
  });
});

describe('createLlmClient', () => {
  const db = openDatabase(':memory:');
  it('picks the provider from the environment, defaulting to whichever key is set', () => {
    expect(createLlmClient(db, {}).configured).toBe(false);
    expect(createLlmClient(db, { GEMINI_API_KEY: 'g' }).describe()).toBe('gemini · extraction: gemini-3.5-flash-lite; synthesis: gemini-3.6-flash');
    expect(createLlmClient(db, { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' }).describe()).toMatch(/^anthropic/);
    expect(createLlmClient(db, { FINN_LLM_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', FINN_GEMINI_MODEL_SYNTHESIS: 'gemini-3.8-flash' }).describe()).toMatch(/^gemini.*synthesis: gemini-3\.8-flash$/);
  });

  it('explains a missing key or an unknown provider instead of failing later', () => {
    expect(createLlmClient(db, { FINN_LLM_PROVIDER: 'gemini' }).describe()).toMatch(/GEMINI_API_KEY is not set/);
    expect(createLlmClient(db, { FINN_LLM_PROVIDER: 'openai', GEMINI_API_KEY: 'g' })).toMatchObject({ configured: false });
  });
});
