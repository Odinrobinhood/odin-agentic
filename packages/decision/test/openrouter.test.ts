import { describe, expect, it } from 'vitest';
import { OpenRouterProvider, openRouterModels } from '../src/openrouter.ts';

const MODEL = 'openrouter/vendor/small-model';
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('OpenRouterProvider', () => {
  it('only offers models the operator allowlisted', () => {
    expect(openRouterModels({ OPENROUTER_MODELS: 'vendor/small-model, bad id ,x/y' })).toEqual([MODEL, 'openrouter/x/y']);
    const p = new OpenRouterProvider({ apiKey: 'k', models: [MODEL], fetchImpl: reply({}) });
    expect(p.supports(MODEL)).toBe(true);
    expect(p.supports('openrouter/vendor/other')).toBe(false);
    expect(p.supports('claude-haiku-5-5')).toBe(false);
  });

  it('sends structured output, privacy routing and the bare model id; returns text and tokens', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ model: 'vendor/small-model', choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }) as typeof fetch;
    const p = new OpenRouterProvider({ apiKey: 'k', models: [MODEL], fetchImpl });
    const out = await p.complete({ system: 's', user: 'u', model: MODEL, maxTokens: 2000 });
    expect(sent.model).toBe('vendor/small-model');
    expect(sent.provider).toEqual({ require_parameters: true, data_collection: 'deny' });
    expect((sent.response_format as { type: string; json_schema: { strict: boolean } }).json_schema.strict).toBe(true);
    expect(out).toEqual({ text: '{"a":1}', stopReason: 'stop', model: MODEL, tokensUsed: 15 });
  });

  it('maps truncation and content filtering; surfaces API errors', async () => {
    const trunc = new OpenRouterProvider({ apiKey: 'k', models: [MODEL], fetchImpl: reply({ choices: [{ message: { content: '{"a"' }, finish_reason: 'length' }] }) as typeof fetch });
    expect((await trunc.complete({ system: 's', user: 'u', model: MODEL, maxTokens: 10 })).stopReason).toBe('max_tokens');
    const filtered = new OpenRouterProvider({ apiKey: 'k', models: [MODEL], fetchImpl: reply({ choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] }) as typeof fetch });
    expect((await filtered.complete({ system: 's', user: 'u', model: MODEL, maxTokens: 10 })).text).toBeNull();
    const err = new OpenRouterProvider({ apiKey: 'k', models: [MODEL], fetchImpl: reply({ error: { message: 'no endpoints found' } }, 404) as typeof fetch });
    await expect(err.complete({ system: 's', user: 'u', model: MODEL, maxTokens: 10 })).rejects.toThrow(/openrouter 404: no endpoints found/);
  });
});
