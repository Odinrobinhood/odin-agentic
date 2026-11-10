import { ClaudeProvider } from './claude.ts';
import { DECISION_JSON_SCHEMA, type DecisionProvider } from './types.ts';

/** Odin model names for OpenRouter models: `openrouter/<OpenRouter model id>`, e.g. `openrouter/<vendor>/<model>`. */
export const OPENROUTER_PREFIX = 'openrouter/';

/**
 * Models the operator allows through OpenRouter (env OPENROUTER_MODELS, comma-separated OpenRouter ids). Nothing is
 * hardcoded: model ids change often and an unlisted model can never be selected.
 */
export function openRouterModels(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OPENROUTER_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9._-]+\/[a-zA-Z0-9._:-]+$/.test(s))
    .map((id) => `${OPENROUTER_PREFIX}${id}`);
}

type ChatResult = {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: number | string };
};

/**
 * OpenRouter (OpenAI-compatible Chat Completions) for agent decisions and AI signals. The reply must match the
 * same JSON schema as Claude's and is validated by the same zod schema afterwards, so a weaker model can only
 * make an agent hold, never bypass the Risk Engine or the signer.
 *
 * Routing: only providers that support every parameter sent (structured outputs) and do not store or train on
 * prompts (`data_collection: deny`); OPENROUTER_ZDR=1 restricts further to zero-data-retention endpoints.
 */
export class OpenRouterProvider implements DecisionProvider {
  readonly name = 'openrouter';
  private readonly apiKey: string;
  private readonly allowed: Set<string>;
  private readonly zdr: boolean;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; models: string[]; zdr?: boolean; baseUrl?: string; fetchImpl?: typeof fetch }) {
    if (!opts.apiKey) throw new Error('OpenRouter API key missing');
    this.apiKey = opts.apiKey;
    this.allowed = new Set(opts.models);
    this.zdr = opts.zdr ?? false;
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  supports(model: string): boolean {
    return this.allowed.has(model);
  }

  async complete(req: { system: string; user: string; model: string; maxTokens: number; schema?: Record<string, unknown> }) {
    if (!this.supports(req.model)) throw new Error(`model ${req.model} is not allowed through OpenRouter`);
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model.slice(OPENROUTER_PREFIX.length),
        max_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'odin_output', strict: true, schema: req.schema ?? DECISION_JSON_SCHEMA } },
        provider: { require_parameters: true, data_collection: 'deny', ...(this.zdr ? { zdr: true } : {}) },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as ChatResult;
    if (!res.ok || body.error) throw new Error(`openrouter ${res.status}: ${(body.error?.message ?? 'request failed').slice(0, 300)}`);
    const choice = body.choices?.[0];
    const finish = choice?.finish_reason ?? null;
    const u = body.usage ?? {};
    const tokensUsed = u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
    const refused = finish === 'content_filter' || !!choice?.message?.refusal;
    return {
      text: refused ? null : (choice?.message?.content ?? null),
      // the engine treats max_tokens as a truncated (invalid) answer
      stopReason: finish === 'length' ? 'max_tokens' : finish,
      model: body.model ? `${OPENROUTER_PREFIX}${body.model}` : req.model,
      tokensUsed,
    };
  }
}

/**
 * Every decision provider with a credential on this host: Claude (ANTHROPIC_API_KEY) and/or OpenRouter
 * (OPENROUTER_API_KEY + the OPENROUTER_MODELS allowlist). The engine picks the provider whose models include the
 * agent's configured model.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'high'): DecisionProvider[] {
  const out: DecisionProvider[] = [];
  if (env.ANTHROPIC_API_KEY) out.push(new ClaudeProvider({ effort }));
  const models = openRouterModels(env);
  if (env.OPENROUTER_API_KEY && models.length) out.push(new OpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY, models, zdr: env.OPENROUTER_ZDR === '1' }));
  return out;
}
