import { describe, expect, it } from 'vitest';
import { MemoryTokenMeter } from '@odin/decision';
import { AnalystEngine, OpenRouterAnalystLLM, RoutingAnalystLLM, TOOL_DEFS, toChatTools, type AnalystTools } from '../src/index.ts';

const MODEL = 'openrouter/vendor/model';
const tools = { run: async (name: string) => ({ source: name, indexed_to_block: '110000000' }) } as unknown as AnalystTools;

describe('AI Market Analyst through OpenRouter', () => {
  it('runs the engine tool loop over OpenAI-compatible chat completions', async () => {
    const sent: Record<string, unknown>[] = [];
    const replies = [
      { model: 'vendor/model', choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_flows', arguments: '{"token":"WETH","hours":24}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      { model: 'vendor/model', choices: [{ message: { content: 'Net buying (source: get_flows, as of block 110000000).' }, finish_reason: 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 20 } },
    ];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies.shift()));
    }) as typeof fetch;
    const engine = new AnalystEngine({ llm: new OpenRouterAnalystLLM({ apiKey: 'k', fetchImpl }), tools, meter: new MemoryTokenMeter(), config: { model: MODEL, dailyTokenBudget: 1e9 } });

    const a = await engine.ask('u', 'c', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'Who is buying WETH?');
    expect(a.answer).toContain('source: get_flows');
    expect(a.toolCalls).toEqual([{ name: 'get_flows', input: { token: 'WETH', hours: 24 }, ok: true }]);
    expect(a.tokensUsed).toBe(280);
    expect(a.model).toBe(MODEL);

    // first call: bare model id, system first, function tools, privacy routing
    expect(sent[0]!.model).toBe('vendor/model');
    expect((sent[0]!.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[0]!.provider).toEqual({ require_parameters: true, data_collection: 'deny' });
    expect((sent[0]!.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(TOOL_DEFS.map((t) => t.name));
    // second call: the assistant tool call and its result as a `tool` message
    const second = sent[1]!.messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    expect(second.slice(-2).map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(second.at(-2)!.tool_calls![0]!.id).toBe('c1');
    expect(second.at(-1)!.tool_call_id).toBe('c1');
  });

  it('maps a provider refusal and keeps strict only for fully-required schemas', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] }))) as unknown as typeof fetch;
    const engine = new AnalystEngine({ llm: new OpenRouterAnalystLLM({ apiKey: 'k', fetchImpl }), tools, meter: new MemoryTokenMeter(), config: { model: MODEL, dailyTokenBudget: 1e9 } });
    expect((await engine.ask('u', 'c', [], 'q')).refused).toBe(true);
    const t = toChatTools([
      { name: 'a', description: '', input_schema: { type: 'object', properties: { x: {} }, required: ['x'] } },
      { name: 'b', description: '', input_schema: { type: 'object', properties: { x: {}, y: {} }, required: ['x'] } },
    ] as never);
    expect(t.map((x) => 'strict' in x.function)).toEqual([true, false]);
  });

  it('routes by model name and fails clearly without a credential', async () => {
    const r = new RoutingAnalystLLM({ claude: null, openrouter: null });
    await expect(r.call({ model: MODEL, system: '', messages: [], tools: [] })).rejects.toThrow(/no LLM credential/);
    await expect(r.call({ model: 'claude-haiku-5-5', system: '', messages: [], tools: [] })).rejects.toThrow(/no LLM credential/);
  });
});
