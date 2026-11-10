import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { Watchdog, type AlertSink, type WatchdogData } from '../src/watchdog.ts';

const W = getAddress('0x' + '11'.repeat(20));

class Data implements WatchdogData {
  balance = 10n ** 18n;
  drift = 0;
  pending = 0;
  overdue = 0;
  llm = { total: 0, failed: 0 };
  lag: bigint | null = 10n;
  age: number | null = 30;
  failNonce = false;
  async liveAgents() {
    return [{ agentId: 'a1', userId: 'u1', wallet: W }];
  }
  async nativeBalance(_w: Address) {
    return this.balance;
  }
  async nonceDrift() {
    if (this.failNonce) throw new Error('rpc down');
    return [{ wallet: W, agentId: 'a1', chainNonce: 5 + this.drift, recorded: 5, drift: this.drift }];
  }
  async reconcile() {
    return { resolved: 1, pending: this.pending };
  }
  async overdueAgents() {
    return this.overdue;
  }
  async llmOutcomes() {
    return this.llm;
  }
  async indexerLag() {
    return this.lag;
  }
  async snapshotAge() {
    return this.age;
  }
  down: string[] = [];
  async services() {
    return ['market', 'guard'].map((name) => ({ name, ok: !this.down.includes(name), detail: this.down.includes(name) ? 'unreachable' : 'ok' }));
  }
}

class Sink implements AlertSink {
  sent = new Map<string, number>();
  now = 0;
  emitted: { userId: string | null; payload: Record<string, unknown> }[] = [];
  async claim(key: string, cooldown: number) {
    const last = this.sent.get(key);
    if (last !== undefined && this.now - last < cooldown) return false;
    this.sent.set(key, this.now);
    return true;
  }
  async emit(a: { userId: string | null; sourceId: string; payload: Record<string, unknown> }) {
    this.emitted.push(a);
  }
}

describe('Watchdog', () => {
  it('stays quiet when everything is healthy', async () => {
    const sink = new Sink();
    expect((await new Watchdog({ data: new Data(), sink }).runOnce()).length).toBe(0);
    expect(sink.emitted).toEqual([]);
  });

  it('sends low gas to the owner and every other condition to the operator', async () => {
    const d = new Data();
    Object.assign(d, { balance: 10n ** 14n, drift: 2, pending: 1, overdue: 3, llm: { total: 10, failed: 6 }, lag: 9000n, age: 900, down: ['guard'] });
    const sink = new Sink();
    const f = await new Watchdog({ data: d, sink }).runOnce();
    expect(f.map((x) => x.event).sort()).toEqual(['low_gas', 'ops_indexer_lag', 'ops_llm_errors', 'ops_nonce_drift', 'ops_scheduler_lag', 'ops_service_down', 'ops_stale_prices', 'ops_stuck_transactions']);
    const gas = sink.emitted.find((e) => e.payload.event === 'low_gas')!;
    expect(gas).toMatchObject({ userId: 'u1', payload: { agentId: 'a1', operator: false } });
    expect(sink.emitted.filter((e) => e.payload.operator === true).every((e) => e.userId === null)).toBe(true);
  });

  it('does not repeat an alert while the condition persists, until the repeat period passes', async () => {
    const d = new Data();
    d.balance = 1n;
    const sink = new Sink();
    const w = new Watchdog({ data: d, sink, config: { repeatSeconds: 3600 } });
    await w.runOnce();
    await w.runOnce();
    expect(sink.emitted).toHaveLength(1);
    sink.now = 3601;
    await w.runOnce();
    expect(sink.emitted).toHaveLength(2);
  });

  it('ignores LLM failures below the minimum sample size; a failing check alerts the operator', async () => {
    const d = new Data();
    d.llm = { total: 3, failed: 3 };
    d.failNonce = true;
    const sink = new Sink();
    const f = await new Watchdog({ data: d, sink }).runOnce();
    expect(f.map((x) => x.event)).toEqual(['ops_check_failed']);
    expect(sink.emitted[0]!.payload).toMatchObject({ check: 'nonce', error: 'rpc down', operator: true });
  });
});
