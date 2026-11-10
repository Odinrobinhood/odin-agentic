import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import type { RuleData } from '@odin/signals';
import { TriggerWatcher, type TriggerAgent, type TriggerState, type TriggerStore } from '../src/triggers.ts';

const WETH = getAddress('0x' + '22'.repeat(20));

class Store implements TriggerStore {
  list: TriggerAgent[] = [];
  st = new Map<string, TriggerState>();
  wakes: { agentId: string; reason: Record<string, unknown> }[] = [];
  async agents() {
    return this.list;
  }
  async states(agentId: string) {
    return [...this.st.entries()].filter(([k]) => k.startsWith(agentId)).map(([, v]) => v);
  }
  async saveState(agentId: string, s: TriggerState) {
    this.st.set(`${agentId}:${s.idx}`, s);
  }
  async wake(agentId: string, reason: Record<string, unknown>) {
    this.wakes.push({ agentId, reason });
    return true;
  }
}

class Data implements RuleData {
  price = 2000;
  async latestPrice(_t: Address) {
    return { price: this.price, ts: new Date() };
  }
  async priceAt() {
    return 2000;
  }
  async swapVolume() {
    return 0;
  }
  async poolLiquidity() {
    return 0n;
  }
  async indexedTo() {
    return null;
  }
  async transfers() {
    return [];
  }
}

describe('TriggerWatcher', () => {
  const setup = () => {
    const store = new Store();
    const data = new Data();
    let now = Date.parse('2026-11-10T12:00:00Z');
    const w = new TriggerWatcher({ store, data, now: () => new Date(now) });
    store.list = [{ agentId: 'a1', configVersion: 1, triggers: [{ condition: 'price_below', token: WETH, price: 1900 }, { bogus: true }] }];
    return { store, data, w, advance: (ms: number) => (now += ms) };
  };

  it('wakes the agent once when a condition starts to hold, and re-arms after it stops', async () => {
    const { store, data, w, advance } = setup();
    await w.checkOnce();
    expect(store.wakes).toHaveLength(0);
    data.price = 1890;
    advance(15_000);
    expect(await w.checkOnce()).toEqual([{ agentId: 'a1', idx: 0, woke: true }]);
    expect(store.wakes[0]!.reason).toMatchObject({ trigger: 0, condition: 'price_below', detail: { price: 1890, threshold: 1900 } });
    advance(120_000);
    await w.checkOnce(); // still below: no repeat
    expect(store.wakes).toHaveLength(1);
    data.price = 1950;
    advance(15_000);
    await w.checkOnce(); // re-armed
    data.price = 1880;
    advance(15_000);
    await w.checkOnce();
    expect(store.wakes).toHaveLength(2);
  });

  it('never fires more often than once a minute, and catches the edge once the interval passed', async () => {
    const { store, data, w, advance } = setup();
    data.price = 1890;
    await w.checkOnce();
    data.price = 1950;
    advance(10_000);
    await w.checkOnce();
    data.price = 1890;
    advance(10_000);
    await w.checkOnce(); // edge within 60s of the last fire: suppressed
    expect(store.wakes).toHaveLength(1);
    advance(45_000);
    await w.checkOnce(); // still holding, interval passed: fires now
    expect(store.wakes).toHaveLength(2);
  });

  it('a new config version starts every trigger armed again; invalid entries are skipped', async () => {
    const { store, data, w, advance } = setup();
    data.price = 1890;
    await w.checkOnce();
    store.list[0]!.configVersion = 2;
    advance(70_000);
    await w.checkOnce();
    expect(store.wakes).toHaveLength(2);
    expect([...store.st.keys()]).toEqual(['a1:0']);
  });
});
