import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPool, type Pool } from '@odin/db';
import { deriveAgentKey } from '../src/keys.ts';
import { PgPolicyStore } from '../src/policy.ts';

// Runs only against a real, migrated Postgres: TEST_DATABASE_URL=postgresql://...
const url = process.env.TEST_DATABASE_URL;
const seed = new Uint8Array(64).fill(7);
const derive = (i: bigint): Address => privateKeyToAccount(deriveAgentKey(seed, i)).address;
const rnd = () => getAddress(`0x${randomUUID().replaceAll('-', '').padEnd(40, 'a')}`);

describe.skipIf(!url)('signer vault bindings (postgres)', () => {
  let pool: Pool;
  let store: PgPolicyStore;
  const base = BigInt(Math.floor(Math.random() * 1e12)) + 10n ** 12n;

  async function agent(owner: Address, index: bigint, address = derive(index)) {
    const u = await pool.query<{ id: string }>(
      'INSERT INTO users (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address RETURNING id',
      [owner.toLowerCase()],
    );
    const a = await pool.query<{ id: string }>("INSERT INTO agents (user_id, name) VALUES ($1, 'vault-test') RETURNING id", [u.rows[0]!.id]);
    await pool.query('INSERT INTO agent_wallets (agent_id, address, derivation_index) VALUES ($1, $2, $3)', [a.rows[0]!.id, address.toLowerCase(), index.toString()]);
    return { agentId: a.rows[0]!.id, userId: u.rows[0]!.id };
  }

  beforeAll(() => {
    pool = createPool(url!, { max: 5 });
    store = new PgPolicyStore(pool, derive);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('keeps the first owner and index even if app tables are rewritten', async () => {
    const victim = rnd();
    const attacker = rnd();
    const v = await agent(victim, base);
    expect((await store.walletOwner(v.agentId))?.owner).toBe(victim);

    // compromised app role re-points the agent at the attacker
    const a = await agent(attacker, base + 1n);
    await pool.query('UPDATE agents SET user_id = $2 WHERE id = $1', [v.agentId, a.userId]);
    const w = await store.walletOwner(v.agentId);
    expect(w?.owner).toBe(victim);
    expect(w?.wallet).toBe(derive(base));
  });

  it('never binds a second agent to an index that already belongs to another agent', async () => {
    const victim = await agent(rnd(), base + 2n);
    await store.walletOwner(victim.agentId);
    // the app forges another agent row reusing the victim's index (dropping its unique constraint first)
    await pool.query('ALTER TABLE agent_wallets DROP CONSTRAINT IF EXISTS agent_wallets_derivation_index_key');
    await pool.query('ALTER TABLE agent_wallets DROP CONSTRAINT IF EXISTS agent_wallets_address_key');
    try {
      const forged = await agent(rnd(), base + 2n);
      await expect(store.walletOwner(forged.agentId)).rejects.toMatchObject({ code: 'unknown_agent' });
    } finally {
      await pool.query(`DELETE FROM agent_wallets w USING agents a WHERE a.id = w.agent_id AND a.name = 'vault-test' AND w.derivation_index = $1
                          AND w.agent_id <> $2`, [(base + 2n).toString(), victim.agentId]);
      await pool.query('ALTER TABLE agent_wallets ADD CONSTRAINT agent_wallets_derivation_index_key UNIQUE (derivation_index)');
      await pool.query('ALTER TABLE agent_wallets ADD CONSTRAINT agent_wallets_address_key UNIQUE (address)');
    }
  });

  it('refuses a wallet address that does not derive from its index', async () => {
    const x = await agent(rnd(), base + 3n, rnd());
    await expect(store.walletOwner(x.agentId)).rejects.toMatchObject({ code: 'unknown_agent' });
  });
});
