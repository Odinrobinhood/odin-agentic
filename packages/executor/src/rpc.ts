import { getAddress, type Address, type Hex } from 'viem';

export class RpcError extends Error {
  readonly url: string;
  readonly rpcCode: number | undefined;
  constructor(url: string, message: string, rpcCode?: number) {
    super(message);
    this.name = 'RpcError';
    this.url = url;
    this.rpcCode = rpcCode;
  }
}

export type RpcLog = { address: Address; topics: Hex[]; data: Hex; logIndex: number };
export type RpcReceipt = {
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: RpcLog[];
};

export interface RpcEndpoint {
  readonly url: string;
  call<T>(method: string, params: unknown[]): Promise<T>;
}

/** Minimal JSON-RPC over fetch, so broadcast errors reach us verbatim for classification. */
export class JsonRpc implements RpcEndpoint {
  readonly url: string;
  private readonly timeoutMs: number;
  private id = 0;

  constructor(url: string, timeoutMs = 8_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RpcError(this.url, `transport: ${(e as Error).message}`);
    }
    if (!res.ok) throw new RpcError(this.url, `http ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new RpcError(this.url, body.error.message, body.error.code);
    return body.result as T;
  }
}

/** Read-side chain access used by the executor; reads go through an ordered fallback. */
export interface ExecChain {
  readonly endpoints: RpcEndpoint[];
  chainId(): Promise<number>;
  nonce(addr: Address, tag: 'latest' | 'pending'): Promise<number>;
  baseFee(): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  receipt(hash: Hex): Promise<RpcReceipt | null>;
}

export class FallbackChain implements ExecChain {
  readonly endpoints: RpcEndpoint[];

  constructor(urls: string[]) {
    if (urls.length === 0) throw new Error('at least one RPC url is required');
    this.endpoints = urls.map((u) => new JsonRpc(u));
  }

  private async read<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (const ep of this.endpoints) {
      try {
        return await ep.call<T>(method, params);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  async chainId(): Promise<number> {
    return Number(await this.read<Hex>('eth_chainId', []));
  }

  async nonce(addr: Address, tag: 'latest' | 'pending'): Promise<number> {
    return Number(await this.read<Hex>('eth_getTransactionCount', [addr, tag]));
  }

  async baseFee(): Promise<bigint> {
    const block = await this.read<{ baseFeePerGas?: Hex }>('eth_getBlockByNumber', ['latest', false]);
    return BigInt(block.baseFeePerGas ?? '0x0');
  }

  async allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    // allowance(address,address) = 0xdd62ed3e
    const data = `0xdd62ed3e${owner.slice(2).padStart(64, '0')}${spender.slice(2).padStart(64, '0')}`.toLowerCase();
    return BigInt(await this.read<Hex>('eth_call', [{ to: token, data }, 'latest']));
  }

  async receipt(hash: Hex): Promise<RpcReceipt | null> {
    const r = await this.read<{
      transactionHash: Hex;
      status: Hex;
      blockNumber: Hex;
      gasUsed: Hex;
      effectiveGasPrice?: Hex;
      logs: { address: string; topics: Hex[]; data: Hex; logIndex: Hex }[];
    } | null>('eth_getTransactionReceipt', [hash]);
    if (!r) return null;
    return {
      transactionHash: r.transactionHash,
      status: r.status === '0x1' ? 'success' : 'reverted',
      blockNumber: BigInt(r.blockNumber),
      gasUsed: BigInt(r.gasUsed),
      effectiveGasPrice: BigInt(r.effectiveGasPrice ?? '0x0'),
      logs: r.logs.map((l) => ({ address: getAddress(l.address), topics: l.topics, data: l.data, logIndex: Number(l.logIndex) })),
    };
  }
}
