import { getAddress, isAddress } from 'viem';
import { buildPrompt, sha256 } from './prompt.ts';
import { DecisionSchema, type DecideResult, type DecisionContext, type DecisionProvider } from './types.ts';

/** Per-user daily LLM token meter (architecture §3.5); shared with the Analyst and Signals. */
export interface TokenMeter {
  usedToday(userId: string, day: string): Promise<number>;
  add(userId: string, source: 'agent' | 'analyst' | 'signal', sourceId: string, day: string, tokens: number): Promise<void>;
}

export type DecisionEngineConfig = { dailyTokenBudget: number };

export class DecisionEngine {
  private readonly providers: DecisionProvider[];
  private readonly meter: TokenMeter;
  private readonly cfg: DecisionEngineConfig;
  private readonly now: () => Date;

  constructor(deps: { providers: DecisionProvider[]; meter: TokenMeter; config: DecisionEngineConfig; now?: () => Date }) {
    this.providers = deps.providers;
    this.meter = deps.meter;
    this.cfg = deps.config;
    this.now = deps.now ?? (() => new Date());
  }

  async decide(ctx: DecisionContext): Promise<DecideResult> {
    const { system, user } = buildPrompt(ctx);
    const promptHash = sha256(`${ctx.model}\n${system}\n${user}`);
    const base = { model: ctx.model, promptHash, responseHash: sha256(''), tokensUsed: 0 };
    const day = this.now().toISOString().slice(0, 10);

    // budget exhausted → hold until reset; guards are unaffected (they never call the LLM)
    if ((await this.meter.usedToday(ctx.userId, day)) >= this.cfg.dailyTokenBudget) {
      return { ok: false, reason: 'budget_exhausted', message: 'daily LLM token budget exhausted', ...base };
    }
    const provider = this.providers.find((p) => p.supports(ctx.model));
    if (!provider) return { ok: false, reason: 'provider_error', message: `no provider for model ${ctx.model}`, ...base };

    let out;
    try {
      out = await provider.complete({ system, user, model: ctx.model, maxTokens: ctx.maxTokens });
    } catch (e) {
      return { ok: false, reason: 'provider_error', message: (e as Error).message.slice(0, 500), ...base };
    }
    await this.meter.add(ctx.userId, 'agent', ctx.agentId, day, out.tokensUsed);
    const meta = { model: out.model, promptHash, responseHash: sha256(out.text ?? ''), tokensUsed: out.tokensUsed };

    if (out.text === null) return { ok: false, reason: 'model_refused', message: `stop_reason ${out.stopReason}`, ...meta };
    if (out.stopReason === 'max_tokens') return { ok: false, reason: 'invalid_output', message: 'output truncated at max_tokens', ...meta };

    let json: unknown;
    try {
      json = JSON.parse(out.text);
    } catch {
      return { ok: false, reason: 'invalid_output', message: 'response is not JSON', ...meta };
    }
    const parsed = DecisionSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: 'invalid_output', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), ...meta };
    const d = parsed.data;

    // shape rules the schema cannot express
    if (d.action === 'hold') return { ok: true, decision: { ...d, token: null, size: null }, ...meta };
    if (!d.token || !isAddress(d.token, { strict: false })) return { ok: false, reason: 'invalid_output', message: 'trade without a token address', ...meta };
    const token = getAddress(d.token);
    // a token outside the agent's assets is rejected, never guessed (architecture §3.5)
    if (!ctx.assets.some((a) => a.address === token)) return { ok: false, reason: 'invalid_output', message: `token ${token} is not an allowed asset`, ...meta };
    if (!d.size) return { ok: false, reason: 'invalid_output', message: 'trade without a size', ...meta };
    if (d.action === 'buy' && d.size.type !== 'quote_amount') return { ok: false, reason: 'invalid_output', message: 'buy must be sized as quote_amount', ...meta };
    return { ok: true, decision: { ...d, token }, ...meta };
  }
}
