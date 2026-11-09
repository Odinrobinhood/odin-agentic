import { getAddress, type Address } from 'viem';
import type { Pool } from '@odin/db';

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

/** Reads policy straight from Postgres with the signer's read-only role; nothing comes from the caller. */
export class PgPolicyStore implements PolicyStore {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async walletOwner(agentId: string): Promise<WalletOwner | null> {
    const r = await this.pool.query<{ derivation_index: string; address: string; custody: string; owner: string }>(
      `SELECT w.derivation_index, w.address, w.custody, u.wallet_address AS owner
         FROM agents a JOIN agent_wallets w ON w.agent_id = a.id JOIN users u ON u.id = a.user_id
        WHERE a.id = $1`,
      [agentId],
    );
    const x = r.rows[0];
    if (!x || x.custody !== 'derived') return null;
    return { agentId, derivationIndex: BigInt(x.derivation_index), wallet: getAddress(x.address), owner: getAddress(x.owner) };
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
      derivationIndex: BigInt(row.derivation_index),
      wallet: getAddress(row.address),
      quoteAsset,
      assets: assetSet,
      stockTokens,
      heldTokens,
      openLivePositions: heldTokens.size,
    };
  }
}
