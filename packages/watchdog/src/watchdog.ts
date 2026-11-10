import type { Address } from 'viem';

/** What the watchdog reads. Postgres + chain in production; fakes in tests. */
export interface WatchdogData {
  /** Agents that trade with real funds (live mode, or holding live positions) and are not retired. */
  liveAgents(): Promise<{ agentId: string; userId: string; wallet: Address }[]>;
  nativeBalance(wallet: Address): Promise<bigint>;
  /** On-chain nonce minus recorded nonce-consuming executions, per wallet that has executions. */
  nonceDrift(): Promise<{ wallet: Address; agentId: string; chainNonce: number; recorded: number; drift: number }[]>;
  /** Resolve executions stuck in signed/broadcast; returns how many are still unresolved. */
  reconcile(): Promise<{ resolved: number; pending: number }>;
  /** Active agents whose tick is overdue by more than `seconds` (or that were never scheduled) and that nobody holds a lease on. */
  overdueAgents(seconds: number): Promise<number>;
  /** Agent decisions in the window and how many failed because the LLM was unavailable or invalid. */
  llmOutcomes(minutes: number): Promise<{ total: number; failed: number }>;
  /** Blocks between the chain head and the slowest indexer stream. */
  indexerLag(): Promise<bigint | null>;
  /** Seconds since the newest market snapshot. */
  snapshotAge(): Promise<number | null>;
  /** /healthz of every service expected to run on this host. */
  services(): Promise<{ name: string; ok: boolean; detail: string }[]>;
}

export interface AlertSink {
  /** True if no alert with this key was sent within `cooldownSeconds` (and records this one). */
  claim(key: string, cooldownSeconds: number, detail: unknown): Promise<boolean>;
  /** User-facing (userId set) or operator alert (userId null). */
  emit(a: { userId: string | null; sourceId: string; payload: Record<string, unknown> }): Promise<void>;
}

export type WatchdogConfig = {
  lowGasWei: bigint;
  overdueSeconds: number;
  llmWindowMinutes: number;
  llmFailureRatio: number;
  llmMinSamples: number;
  indexerMaxLagBlocks: bigint;
  snapshotMaxAgeSeconds: number;
  /** Do not repeat the same alert within this period while the condition persists. */
  repeatSeconds: number;
};

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  lowGasWei: 1_000_000_000_000_000n, // 0.001 ETH: twice the runtime's default gas reserve
  overdueSeconds: 180,
  llmWindowMinutes: 15,
  llmFailureRatio: 0.5,
  llmMinSamples: 5,
  indexerMaxLagBlocks: 6_000n, // ~10 minutes at ~10 blocks/s
  snapshotMaxAgeSeconds: 300,
  repeatSeconds: 6 * 3600,
};

export type Finding = { key: string; operator: boolean; event: string; detail: Record<string, unknown>; sent: boolean };

/**
 * Watchdog (architecture §8, §3.11): low gas balances go to the agent's owner; nonce drift, stuck
 * transactions, scheduler lag, LLM failures and stale data go to the operator. Each condition alerts once
 * per `repeatSeconds` while it persists.
 */
export class Watchdog {
  private readonly data: WatchdogData;
  private readonly sink: AlertSink;
  private readonly cfg: WatchdogConfig;

  constructor(deps: { data: WatchdogData; sink: AlertSink; config?: Partial<WatchdogConfig> }) {
    this.data = deps.data;
    this.sink = deps.sink;
    this.cfg = { ...DEFAULT_WATCHDOG, ...deps.config };
  }

  async runOnce(): Promise<Finding[]> {
    const out: Finding[] = [];
    const raise = async (key: string, operator: boolean, event: string, detail: Record<string, unknown>, userId: string | null = null, sourceId = '00000000-0000-0000-0000-000000000000') => {
      const sent = await this.sink.claim(key, this.cfg.repeatSeconds, detail);
      if (sent) await this.sink.emit({ userId, sourceId, payload: { event, operator, ...detail } });
      out.push({ key, operator, event, detail, sent });
    };
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        // a failing check is itself an operator problem
        await raise(`check_failed:${name}`, true, 'ops_check_failed', { check: name, error: (e as Error).message.split('\n')[0] ?? 'error' });
      }
    };

    await step('low_gas', async () => {
      for (const a of await this.data.liveAgents()) {
        const bal = await this.data.nativeBalance(a.wallet);
        if (bal < this.cfg.lowGasWei) {
          await raise(`low_gas:${a.agentId}`, false, 'low_gas', { agentId: a.agentId, wallet: a.wallet, balanceWei: bal.toString(), thresholdWei: this.cfg.lowGasWei.toString() }, a.userId, a.agentId);
        }
      }
    });
    await step('reconcile', async () => {
      const r = await this.data.reconcile();
      if (r.pending > 0) await raise('stuck_tx', true, 'ops_stuck_transactions', { pending: r.pending, resolved: r.resolved });
    });
    await step('nonce', async () => {
      for (const n of await this.data.nonceDrift()) {
        if (n.drift !== 0) await raise(`nonce_drift:${n.wallet}`, true, 'ops_nonce_drift', { ...n });
      }
    });
    await step('scheduler', async () => {
      const overdue = await this.data.overdueAgents(this.cfg.overdueSeconds);
      if (overdue > 0) await raise('scheduler_lag', true, 'ops_scheduler_lag', { overdueAgents: overdue, overdueSeconds: this.cfg.overdueSeconds });
    });
    await step('llm', async () => {
      const o = await this.data.llmOutcomes(this.cfg.llmWindowMinutes);
      if (o.total >= this.cfg.llmMinSamples && o.failed / o.total >= this.cfg.llmFailureRatio) {
        await raise('llm_errors', true, 'ops_llm_errors', { failed: o.failed, total: o.total, windowMinutes: this.cfg.llmWindowMinutes });
      }
    });
    await step('indexer', async () => {
      const lag = await this.data.indexerLag();
      if (lag !== null && lag > this.cfg.indexerMaxLagBlocks) await raise('indexer_lag', true, 'ops_indexer_lag', { lagBlocks: lag.toString() });
    });
    await step('services', async () => {
      for (const s of await this.data.services()) {
        if (!s.ok) await raise(`service_down:${s.name}`, true, 'ops_service_down', { service: s.name, detail: s.detail });
      }
    });
    await step('snapshots', async () => {
      const age = await this.data.snapshotAge();
      if (age === null || age > this.cfg.snapshotMaxAgeSeconds) await raise('stale_prices', true, 'ops_stale_prices', { ageSeconds: age });
    });
    return out;
  }
}
