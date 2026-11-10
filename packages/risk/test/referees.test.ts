import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { loadReferees } from '../src/referees.ts';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const FEED = '0x321A36e441DfBadA01Aa6f9884F14a344E133D1F';
const file = (body: unknown) => {
  const p = join(mkdtempSync(join(tmpdir(), 'ref-')), 'feeds.json');
  writeFileSync(p, JSON.stringify(body));
  return p;
};

describe('loadReferees', () => {
  it('without a file only USDG has a referee (fixed 1)', () => {
    const m = loadReferees(undefined, USDG);
    expect([...m.entries()]).toEqual([[USDG, { fixedUsd: 1 }]]);
  });
  it('adds verified feeds keyed by checksummed token', () => {
    const m = loadReferees(file({ feeds: [{ symbol: 'NVDA', token: NVDA, feed: FEED, maxAgeSeconds: 90000 }] }), USDG);
    expect(m.get(getAddress(NVDA))).toEqual({ feed: FEED, maxAgeSeconds: 90000 });
    expect(m.size).toBe(2);
  });
  it('rejects malformed or duplicate entries instead of skipping them', () => {
    expect(() => loadReferees(file({}), USDG)).toThrow(/feeds/);
    expect(() => loadReferees(file({ feeds: [{ token: NVDA, feed: '0x12', maxAgeSeconds: 1 }] }), USDG)).toThrow();
    expect(() => loadReferees(file({ feeds: [{ token: NVDA, feed: FEED, maxAgeSeconds: 0 }] }), USDG)).toThrow(/maxAgeSeconds/);
    expect(() => loadReferees(file({ feeds: [{ token: USDG, feed: FEED, maxAgeSeconds: 60 }] }), USDG)).toThrow(/duplicate/);
  });
});
