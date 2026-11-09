import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveAgentKey } from '../src/keys.ts';

describe('deriveAgentKey', () => {
  const seed = new Uint8Array(32).fill(1);

  it('is deterministic per index and distinct across indexes and seeds', () => {
    expect(deriveAgentKey(seed, 0n)).toBe(deriveAgentKey(seed, 0n));
    expect(deriveAgentKey(seed, 0n)).not.toBe(deriveAgentKey(seed, 1n));
    expect(deriveAgentKey(new Uint8Array(32).fill(2), 0n)).not.toBe(deriveAgentKey(seed, 0n));
  });

  it('produces usable secp256k1 keys', () => {
    for (let i = 0n; i < 20n; i++) expect(privateKeyToAccount(deriveAgentKey(seed, i)).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('rejects negative indexes', () => {
    expect(() => deriveAgentKey(seed, -1n)).toThrow();
  });
});
