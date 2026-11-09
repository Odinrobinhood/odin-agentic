import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { MemoryTokenMeter } from '@odin/decision';
import { AnalystEngine, ANALYST_SYSTEM, TOOL_DEFS, type AnalystLLM, type AnalystTools } from '../src/index.ts';

type Msg = Anthropic.Beta.BetaMessage;
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Msg['usage'];
const reply = (content: unknown[], stop: string): Msg => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, usage } as unknown as Msg);

class Scripted implements AnalystLLM {
  steps: Msg[];
  seen: { messages: Anthropic.Beta.BetaMessageParam[]; tools: Anthropic.Beta.BetaTool[]; system: string }[] = [];
  constructor(steps: Msg[]) {
    this.steps = steps;
  }
  async call(req: { model: string; system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools: Anthropic.Beta.BetaTool[] }) {
    this.seen.push({ messages: structuredClone(req.messages), tools: req.tools, system: req.system });
    return this.steps.shift()!;
  }
}

const fakeTools = (fail = false) =>
  ({
    run: async (name: string, input: Record<string, unknown>) => {
      if (fail) throw new Error('rpc down');
      return name === 'get_holders' ? { source: name, as_of_block: '109900000', input } : { source: name, indexed_to_block: '109800000', input };
    },
  }) as unknown as AnalystTools;

const engine = (llm: AnalystLLM, tools = fakeTools(), budget = 1e9) =>
  new AnalystEngine({ llm, tools, meter: new MemoryTokenMeter(), config: { model: 'claude-opus-5-5', dailyTokenBudget: budget } });

describe('AnalystEngine', () => {
  it('runs the tool loop, returns the final answer with tool calls, the newest as-of block and tokens', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    const llm = new Scripted([
      reply([thinking, { type: 'tool_use', id: 't1', name: 'get_flows', input: { token: 'WETH', hours: 24 } }, { type: 'tool_use', id: 't2', name: 'get_holders', input: { token: 'WETH', top: 5 } }], 'tool_use'),
      reply([{ type: 'text', text: 'Net buying of 12 WETH (source: get_flows, as of block 109800000).' }], 'end_turn'),
    ]);
    const a = await engine(llm).ask('u', 'c', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'Who is buying WETH?');
    expect(a.answer).toContain('source: get_flows');
    expect(a.toolCalls.map((t) => [t.name, t.ok])).toEqual([['get_flows', true], ['get_holders', true]]);
    expect(a.asOfBlock).toBe('109900000');
    expect(a.tokensUsed).toBe(240);
    // second call carries the assistant turn unchanged (thinking kept) and both results in ONE user turn
    const second = llm.seen[1]!.messages;
    expect(second.slice(0, 3).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[3]).toMatchObject({ role: 'assistant', content: [thinking, { type: 'tool_use' }, { type: 'tool_use' }] });
    expect((second[4]!.content as { type: string; tool_use_id: string }[]).map((c) => [c.type, c.tool_use_id])).toEqual([['tool_result', 't1'], ['tool_result', 't2']]);
    // strict tools and the data/instruction boundary in the system prompt
    expect(llm.seen[0]!.tools.every((t) => (t as { strict?: boolean }).strict === true)).toBe(true);
    expect(llm.seen[0]!.tools.map((t) => t.name)).toEqual(TOOL_DEFS.map((t) => t.name));
    expect(llm.seen[0]!.system).toBe(ANALYST_SYSTEM);
  });

  it('returns tool failures to the model as is_error results instead of crashing', async () => {
    const llm = new Scripted([
      reply([{ type: 'tool_use', id: 't1', name: 'get_token', input: { query: 'X' } }], 'tool_use'),
      reply([{ type: 'text', text: 'The token data is unavailable right now.' }], 'end_turn'),
    ]);
    const a = await engine(llm, fakeTools(true)).ask('u', 'c', [], 'X?');
    expect(a.toolCalls).toEqual([{ name: 'get_token', input: { query: 'X' }, ok: false }]);
    expect((llm.seen[1]!.messages.at(-1)!.content as { is_error?: boolean }[])[0]!.is_error).toBe(true);
  });

  it('handles refusals, step limits and an exhausted budget', async () => {
    expect((await engine(new Scripted([reply([], 'refusal')])).ask('u', 'c', [], 'q')).refused).toBe(true);
    const loop = new Scripted(Array.from({ length: 10 }, () => reply([{ type: 'tool_use', id: 't', name: 'get_portfolio', input: {} }], 'tool_use')));
    expect((await engine(loop).ask('u', 'c', [], 'q')).answer).toContain('too many steps');
    const none = new Scripted([]);
    expect((await engine(none, fakeTools(), 0).ask('u', 'c', [], 'q')).refused).toBe(true);
    expect(none.seen).toHaveLength(0);
  });
});
