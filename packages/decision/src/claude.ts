import Anthropic from '@anthropic-ai/sdk';
import { DECISION_JSON_SCHEMA, type DecisionProvider } from './types.ts';

/** Claude models offered for agents at launch (architecture §11.2). Default is the first. */
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

/**
 * Claude provider. Uses structured outputs so the response is JSON matching the decision schema,
 * adaptive thinking (always on for these models) with an explicit effort, and the server-side refusal
 * fallback so a classifier decline is re-run on Anthropic's recommended model instead of failing the tick.
 */
export class ClaudeProvider implements DecisionProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  constructor(opts: { client?: Anthropic; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } = {}) {
    this.client = opts.client ?? new Anthropic();
    this.effort = opts.effort ?? 'high';
  }

  supports(model: string): boolean {
    return (CLAUDE_MODELS as readonly string[]).includes(model);
  }

  async complete(req: { system: string; user: string; model: string; maxTokens: number }) {
    // Haiku has no server-side fallback; on Opus/Sonnet a refusal is re-run on Anthropic's recommended model
    const fallback = req.model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };
    const response = await this.client.beta.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.user }],
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort, format: { type: 'json_schema', schema: DECISION_JSON_SCHEMA } },
      ...fallback,
    });

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const u = response.usage;
    const tokensUsed = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return { text: response.stop_reason === 'refusal' ? null : text, stopReason: response.stop_reason, model: response.model, tokensUsed };
  }
}
