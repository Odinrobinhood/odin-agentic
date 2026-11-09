import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getAddress, type Address, type Hex } from 'viem';
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import type { Pool } from '@odin/db';
import { Rejection } from '@odin/shared';

export type AuthConfig = {
  /** Must equal the site the user signs on (SIWE `domain`). */
  domain: string;
  uri: string;
  chainId: number;
  jwtKey: Uint8Array;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  nonceTtlSeconds: number;
};

/** Verifies an EIP-4361 signature (EOA or ERC-1271 smart wallet via the chain RPC). */
export type SignatureVerifier = (args: { address: Address; message: string; signature: Hex }) => Promise<boolean>;

export type Tokens = { accessToken: string; refreshToken: string; expiresIn: number; userId: string; address: Address };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ISSUER = 'odin-agentic';

export class AuthService {
  private readonly pool: Pool;
  private readonly cfg: AuthConfig;
  private readonly verify: SignatureVerifier;
  private readonly now: () => Date;

  constructor(deps: { pool: Pool; config: AuthConfig; verify: SignatureVerifier; now?: () => Date }) {
    this.pool = deps.pool;
    this.cfg = deps.config;
    this.verify = deps.verify;
    this.now = deps.now ?? (() => new Date());
  }

  async nonce(): Promise<{ nonce: string; domain: string; uri: string; chainId: number; expiresAt: string }> {
    const nonce = generateSiweNonce();
    const expiresAt = new Date(this.now().getTime() + this.cfg.nonceTtlSeconds * 1000);
    await this.pool.query('INSERT INTO siwe_nonces (nonce, expires_at) VALUES ($1, $2)', [nonce, expiresAt]);
    return { nonce, domain: this.cfg.domain, uri: this.cfg.uri, chainId: this.cfg.chainId, expiresAt: expiresAt.toISOString() };
  }

  /** Sign-In With Ethereum: domain, chain, nonce (single use), validity window, then the signature. */
  async login(message: string, signature: Hex, userAgent?: string): Promise<Tokens> {
    const fields = parseSiweMessage(message);
    if (!fields.address || !fields.nonce) throw new Rejection('unauthorized', 'malformed SIWE message');
    if (fields.chainId !== this.cfg.chainId) throw new Rejection('unauthorized', 'wrong chain');
    if (fields.uri !== this.cfg.uri) throw new Rejection('unauthorized', 'wrong uri');
    const ok = validateSiweMessage({ message: fields, domain: this.cfg.domain, nonce: fields.nonce, time: this.now() });
    if (!ok) throw new Rejection('unauthorized', 'SIWE message invalid for this domain or expired');
    if (!(await this.verify({ address: fields.address, message, signature }))) throw new Rejection('unauthorized', 'bad signature');

    // consume the nonce atomically; a replayed message fails here
    const used = await this.pool.query('UPDATE siwe_nonces SET used_at = now() WHERE nonce = $1 AND used_at IS NULL AND expires_at > $2', [fields.nonce, this.now()]);
    if (used.rowCount !== 1) throw new Rejection('unauthorized', 'unknown, used or expired nonce');

    const address = getAddress(fields.address);
    const u = await this.pool.query<{ id: string }>(
      `INSERT INTO users (wallet_address, last_siwe_at) VALUES ($1, $2)
       ON CONFLICT (wallet_address) DO UPDATE SET last_siwe_at = EXCLUDED.last_siwe_at RETURNING id`,
      [address.toLowerCase(), this.now()],
    );
    // the SIWE wallet is always part of the user's portfolio (architecture §3.15)
    await this.pool.query(
      `INSERT INTO tracked_wallets (user_id, address, kind, label) VALUES ($1, $2, 'siwe', 'My wallet')
       ON CONFLICT (user_id, address) DO UPDATE SET kind = 'siwe'`,
      [u.rows[0]!.id, address.toLowerCase()],
    );
    return this.issue(u.rows[0]!.id, address, randomUUID(), userAgent);
  }

  /** Rotate a refresh token. Presenting an already-rotated token revokes its whole family. */
  async refresh(refreshToken: string, userAgent?: string): Promise<Tokens> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<{ id: string; user_id: string; family: string; expires_at: Date; rotated_at: Date | null; revoked_at: Date | null; wallet_address: string }>(
        `SELECT s.id, s.user_id, s.family, s.expires_at, s.rotated_at, s.revoked_at, u.wallet_address
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 FOR UPDATE OF s`,
        [sha256(refreshToken)],
      );
      const s = r.rows[0];
      if (!s) throw new Rejection('unauthorized', 'unknown refresh token');
      if (s.rotated_at || s.revoked_at) {
        await client.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE family = $1', [s.family]);
        await client.query('COMMIT');
        throw new Rejection('unauthorized', 'refresh token reuse detected; session revoked');
      }
      if (s.expires_at <= this.now()) throw new Rejection('unauthorized', 'refresh token expired');
      await client.query('UPDATE sessions SET rotated_at = now() WHERE id = $1', [s.id]);
      const tokens = await this.issue(s.user_id, getAddress(s.wallet_address), s.family, userAgent, client);
      await client.query('COMMIT');
      return tokens;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async logout(userId: string, sessionFamily: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND family = $2 AND revoked_at IS NULL', [userId, sessionFamily]);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  }

  /** Verify an access token; also rejects tokens whose session family was revoked (logout-all is immediate). */
  async authenticate(accessToken: string): Promise<{ userId: string; address: Address; family: string; authAt: Date }> {
    let payload;
    try {
      ({ payload } = await jwtVerify(accessToken, this.cfg.jwtKey, { issuer: ISSUER, algorithms: ['HS256'], currentDate: this.now() }));
    } catch {
      throw new Rejection('unauthorized', 'invalid or expired access token');
    }
    const family = String(payload.fam ?? '');
    const live = await this.pool.query('SELECT 1 FROM sessions WHERE family = $1 AND revoked_at IS NULL LIMIT 1', [family]);
    if (!live.rowCount) throw new Rejection('unauthorized', 'session revoked');
    return { userId: String(payload.sub), address: getAddress(String(payload.addr)), family, authAt: new Date(Number(payload.auth_at) * 1000) };
  }

  /** Step-up (architecture §3.2): sensitive actions require a SIWE signature newer than `maxAgeSeconds`. */
  async requireFreshSiwe(userId: string, maxAgeSeconds: number): Promise<void> {
    const r = await this.pool.query<{ last_siwe_at: Date | null }>('SELECT last_siwe_at FROM users WHERE id = $1', [userId]);
    const t = r.rows[0]?.last_siwe_at;
    if (!t || this.now().getTime() - t.getTime() > maxAgeSeconds * 1000) throw new Rejection('unauthorized', 'step-up required: sign in with your wallet again');
  }

  private async issue(userId: string, address: Address, family: string, userAgent?: string, db: Pick<Pool, 'query'> = this.pool): Promise<Tokens> {
    const now = Math.floor(this.now().getTime() / 1000);
    const accessToken = await new SignJWT({ addr: address, fam: family, auth_at: now })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setSubject(userId)
      .setIssuedAt(now)
      .setExpirationTime(now + this.cfg.accessTtlSeconds)
      .sign(this.cfg.jwtKey);
    const refreshToken = randomBytes(32).toString('base64url');
    await db.query(
      'INSERT INTO sessions (user_id, family, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [userId, family, sha256(refreshToken), userAgent?.slice(0, 300) ?? null, new Date((now + this.cfg.refreshTtlSeconds) * 1000)],
    );
    return { accessToken, refreshToken, expiresIn: this.cfg.accessTtlSeconds, userId, address };
  }
}
