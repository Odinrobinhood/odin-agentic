import type { Address, Hex } from 'viem';
import { REJECTION_CODES, Rejection, type ApproveRequest, type RejectionCode, type SwapRequest } from '@odin/shared';

export type SignedIntent = { from: Address; to: Address; txHash: Hex; signedTx: Hex; nonce: number; deadline?: number };

export interface SignerApi {
  approve(req: ApproveRequest): Promise<SignedIntent>;
  swap(req: SwapRequest): Promise<SignedIntent>;
}

/**
 * HTTP client for one signer channel. The channel is fixed by the endpoint + token this client is
 * built with (agent runtime → agent channel, guard watcher → guard channel).
 */
export class HttpSignerClient implements SignerApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token: string, timeoutMs = 30_000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  approve(req: ApproveRequest): Promise<SignedIntent> {
    return this.post('/v1/approve', req);
  }

  swap(req: SwapRequest): Promise<SignedIntent> {
    return this.post('/v1/swap', req);
  }

  private async post(route: string, body: unknown): Promise<SignedIntent> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + route, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Rejection('signer_unavailable', (e as Error).message);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & Partial<SignedIntent>;
    if (!res.ok || json.error) {
      const code = (REJECTION_CODES as readonly string[]).includes(json.error?.code ?? '') ? (json.error!.code as RejectionCode) : 'internal_error';
      throw new Rejection(code, json.error?.message ?? `signer http ${res.status}`);
    }
    return json as SignedIntent;
  }
}
