import { getAddress, type Address } from 'viem';
import type { Pool } from '@odin/db';
import { Rejection } from '@odin/shared';

export type AgentPolicy = {
  agentId: string;
  status: 'draft' | 'active' | 'paused' | 'retired';
  derivationIndex: bigint;
  wallet: Address;
  quoteAsset: Address;
  assets: Set<Address>;
  stockTokens: Set<Address>;
  /** Tokens with an open live position (qty > 0), excluding the quote asset. May include tokens removed from `assets`. */
  heldTokens: Set<Address>;
  openLivePositions: number;
};

/** What withdrawals and key exports need: the derived wallet and its owner (works for any agent status, config or not). */
export type WalletOwner = { agentId: string; derivationIndex: bigint; wallet: Address; owner: Address };

export interface PolicyStore {
  load(agentId: string): Promise<AgentPolicy | null>;
  walletOwner(agentId: string): Promise<WalletOwner | null>;
}

/**
 * Reads policy from Postgres with the signer's role; nothing comes from the caller.
 *
 * Custody facts (agent -> derivation index -> wallet -> owner) come ONLY from the signer vault (schema
 * `signer`, append-only, not writable by the app role). A binding is written the first time the signer
 * sees an agent wallet, after checking the address really derives from that index; app tables can never
 * re-point an agent at another key or another owner afterwards.
 */
export class PgPolicyStore implements PolicyStore {
  private readonly pool: Pool;
  private readonly deriveAddress: (index: bigint) => Address;
  constructor(pool: Pool, deriveAddress: (index: bigint) => Address) {
    this.pool = pool;
    this.deriveAddress = deriveAddress;
  }

  private async readBinding(agentId: string): Promise<WalletOwner | null> {
    const b = await this.pool.query<{ derivation_index: string; wallet: string; owner: string }>(
      'SELECT derivation_index, wallet, owner FROM signer.wallet_bindings WHERE agent_id = $1',
      [agentId],
    );
    const x = b.rows[0];
    return x ? { agentId, derivationIndex: BigInt(x.derivation_index), wallet: getAddress(x.wallet), owner: getAddress(x.owner) } : null;
  }

  /** The vault binding for an agent, created on first sight. Null if the agent has no derived wallet. */
  async binding(agentId: string): Promise<WalletOwner | null> {
    const bound = await this.readBinding(agentId);
    if (bound) return bound;
    const r = await this.pool.query<{ derivation_index: string; address: string; custody: string; owner: string }>(
      `SELECT w.derivation_index, w.address, w.custody, u.wallet_address AS owner
         FROM agents a JOIN agent_wallets w ON w.agent_id = a.id JOIN users u ON u.id = a.user_id
        WHERE a.id = $1`,
      [agentId],
    );
    const x = r.rows[0];
    if (!x || x.custody !== 'derived') return null;
    const index = BigInt(x.derivation_index);
    if (this.deriveAddress(index) !== getAddress(x.address)) {
      throw new Rejection('unknown_agent', `agent wallet ${x.address} does not derive from index ${index}`);
    }
    // ON CONFLICT DO NOTHING covers every unique key: an index or wallet already bound to ANOTHER agent stays unbound
    await this.pool.query(
      'INSERT INTO signer.wallet_bindings (agent_id, derivation_index, wallet, owner) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [agentId, index.toString(), getAddress(x.address).toLowerCase(), getAddress(x.owner).toLowerCase()],
    );
    const fresh = await this.readBinding(agentId);
    if (!fresh) throw new Rejection('unknown_agent', `derivation index ${index} is already bound to another agent`);
    return fresh;
  }

  /** Bind every agent wallet the vault has not seen yet (runs periodically so bindings exist before funds arrive). */
  async bindAll(): Promise<number> {
    const r = await this.pool.query<{ agent_id: string }>(
      `SELECT w.agent_id FROM agent_wallets w
        WHERE w.custody = 'derived' AND NOT EXISTS (SELECT 1 FROM signer.wallet_bindings b WHERE b.agent_id = w.agent_id)
        LIMIT 500`,
    );
    let n = 0;
    for (const { agent_id } of r.rows) {
      try {
        if (await this.binding(agent_id)) n++;
      } catch (e) {
        console.error(JSON.stringify({ msg: 'wallet binding refused', agentId: agent_id, error: (e as Error).message }));
      }
    }
    return n;
  }

  walletOwner(agentId: string): Promise<WalletOwner | null> {
    return this.binding(agentId);
  }

  async load(agentId: string): Promise<AgentPolicy | null> {
    const head = await this.pool.query<{
      status: AgentPolicy['status'];
      derivation_index: string;
      address: string;
      custody: string;
      quote_asset: string | null;
    }>(
      `SELECT a.status, w.derivation_index, w.address, w.custody,
              (SELECT c.quote_asset FROM agent_configs c WHERE c.agent_id = a.id ORDER BY c.version DESC LIMIT 1) AS quote_asset
         FROM agents a JOIN agent_wallets w ON w.agent_id = a.id
        WHERE a.id = $1`,
      [agentId],
    );
    const row = head.rows[0];
    if (!row || row.quote_asset === null) return null;
    // Imported keys are not held by the signer; only derived wallets can be signed for.
    if (row.custody !== 'derived') return null;
    const vault = await this.binding(agentId);
    if (!vault) return null;
    if (vault.wallet !== getAddress(row.address) || vault.derivationIndex !== BigInt(row.derivation_index)) {
      throw new Rejection('unknown_agent', 'agent wallet in app tables does not match the signer vault binding');
    }

    const assets = await this.pool.query<{ token_address: string; is_stock_token: boolean }>(
      `SELECT aa.token_address, t.is_stock_token
         FROM agent_assets aa JOIN tokens t ON t.address = aa.token_address
        WHERE aa.agent_id = $1`,
      [agentId],
    );
    const quote = await this.pool.query<{ is_stock_token: boolean }>('SELECT is_stock_token FROM tokens WHERE address = $1', [row.quote_asset]);
    const held = await this.pool.query<{ token_address: string; is_stock_token: boolean }>(
      `SELECT p.token_address, t.is_stock_token FROM positions p JOIN tokens t ON t.address = p.token_address
        WHERE p.agent_id = $1 AND p.mode = 'live' AND p.qty > 0 AND p.token_address <> $2`,
      [agentId, row.quote_asset],
    );

    const stockTokens = new Set<Address>();
    const assetSet = new Set<Address>();
    for (const a of assets.rows) {
      const addr = getAddress(a.token_address);
      assetSet.add(addr);
      if (a.is_stock_token) stockTokens.add(addr);
    }
    const quoteAsset = getAddress(row.quote_asset);
    if (quote.rows[0]?.is_stock_token) stockTokens.add(quoteAsset);
    const heldTokens = new Set<Address>();
    for (const h of held.rows) {
      const addr = getAddress(h.token_address);
      heldTokens.add(addr);
      if (h.is_stock_token) stockTokens.add(addr);
    }

    return {
      agentId,
      status: row.status,
      derivationIndex: vault.derivationIndex,
      wallet: vault.wallet,
      quoteAsset,
      assets: assetSet,
      stockTokens,
      heldTokens,
      openLivePositions: heldTokens.size,
    };
  }
}
