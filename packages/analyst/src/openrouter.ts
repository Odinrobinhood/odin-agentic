import type Anthropic from '@anthropic-ai/sdk';
import type { AnalystLLM } from './engine.ts';

const PREFIX = 'openrouter/';

type OAMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type ChatResult = {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null; tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('') : '';

/** Anthropic-shaped conversation (what the analyst engine keeps) → OpenAI-compatible chat messages. */
export function toChatMessages(system: string, messages: Anthropic.Beta.BetaMessageParam[]): OAMessage[] {
  const out: OAMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content });
      continue;
    }
    const blocks = m.content as unknown as { type: string; [k: string]: unknown }[];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: String(b.id), type: 'function' as const, function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      // thinking blocks are Claude-specific and dropped
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: String(b.tool_use_id), content: (b.is_error ? 'ERROR: ' : '') + textOf(b.content) });
        else if (b.type === 'text') out.push({ role: 'user', content: String(b.text ?? '') });
      }
    }
  }
  return out;
}

/** Anthropic tool definitions → OpenAI function tools; strict only where the schema allows it (every property required). */
export function toChatTools(tools: Anthropic.Beta.BetaTool[]) {
  return tools.map((t) => {
    const schema = t.input_schema as { properties?: Record<string, unknown>; required?: string[] };
    const props = Object.keys(schema.properties ?? {});
    const strict = props.every((p) => schema.required?.includes(p));
    return { type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters: t.input_schema, ...(strict ? { strict: true } : {}) } };
  });
}

/**
 * The AI Market Analyst through OpenRouter. The engine keeps its conversation in Anthropic's shape; this adapter
 * converts each call to OpenAI-compatible chat completions with function tools and converts the reply back
 * (text → text block, tool_calls → tool_use blocks). Routing: providers that support tools and do not store
 * prompts (`data_collection: deny`; `zdr` optional). Tool results stay untrusted data either way: the system
 * prompt and the read-only tools are the same as with Claude.
 */
export class OpenRouterAnalystLLM implements AnalystLLM {
  private readonly apiKey: string;
  private readonly zdr: boolean;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; zdr?: boolean; baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.zdr = opts.zdr ?? false;
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async call(req: { model: string; system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools: Anthropic.Beta.BetaTool[] }): Promise<Anthropic.Beta.BetaMessage> {
    if (!req.model.startsWith(PREFIX)) throw new Error(`not an OpenRouter model: ${req.model}`);
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model.slice(PREFIX.length),
        max_tokens: 16_000,
        messages: toChatMessages(req.system, req.messages),
        tools: toChatTools(req.tools),
        provider: { require_parameters: true, data_collection: 'deny', ...(this.zdr ? { zdr: true } : {}) },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await res.json().catch(() => ({}))) as ChatResult;
    if (!res.ok || body.error) throw new Error(`openrouter ${res.status}: ${(body.error?.message ?? 'request failed').slice(0, 300)}`);
    const choice = body.choices?.[0];
    const msg = choice?.message ?? {};
    const content: { type: string; [k: string]: unknown }[] = [];
    if (msg.content) content.push({ type: 'text', text: msg.content, citations: null });
    for (const c of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(c.function?.arguments || '{}');
      } catch {
        input = {}; // the tool then reports its missing arguments back to the model
      }
      content.push({ type: 'tool_use', id: c.id, name: c.function?.name ?? '', input });
    }
    const finish = choice?.finish_reason ?? null;
    const stop =
      finish === 'content_filter' || msg.refusal ? 'refusal' : (msg.tool_calls?.length ?? 0) > 0 ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
    return {
      id: body.id ?? 'openrouter',
      type: 'message',
      role: 'assistant',
      model: body.model ? `${PREFIX}${body.model}` : req.model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: body.usage?.prompt_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}

/** Picks the analyst backend by model name: `openrouter/...` → OpenRouter, anything else → Claude. */
export class RoutingAnalystLLM implements AnalystLLM {
  private readonly claude: AnalystLLM | null;
  private readonly openrouter: AnalystLLM | null;
  constructor(backends: { claude?: AnalystLLM | null; openrouter?: AnalystLLM | null }) {
    this.claude = backends.claude ?? null;
    this.openrouter = backends.openrouter ?? null;
  }
  call(req: Parameters<AnalystLLM['call']>[0]) {
    const llm = req.model.startsWith(PREFIX) ? this.openrouter : this.claude;
    if (!llm) return Promise.reject(new Error(`no LLM credential configured on this server for ${req.model}`));
    return llm.call(req);
  }
}
