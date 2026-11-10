import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyEoaSignature, verifyWalletSignature } from '../src/signature.ts';

const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const attacker = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

// an RPC that lies: every eth_call returns true and every address "has code"
let liar = '';
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const r = JSON.parse(body) as { id: number; method: string };
    const result = r.method === 'eth_chainId' ? '0x1237' : r.method === 'eth_getCode' ? '0x6001' : `0x${'0'.repeat(63)}1`;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  liar = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('wallet signatures', () => {
  it('accepts the owner and rejects anyone else locally', async () => {
    const msg = 'export key';
    expect(await verifyEoaSignature(owner.address, msg, await owner.signMessage({ message: msg }))).toBe(true);
    expect(await verifyEoaSignature(owner.address, msg, await attacker.signMessage({ message: msg }))).toBe(false);
    expect(await verifyEoaSignature(owner.address, msg, '0x1234')).toBe(false);
  });
  it('a single lying RPC cannot approve a forged signature', async () => {
    const forged = await attacker.signMessage({ message: 'login' });
    expect(await verifyWalletSignature([liar], owner.address, 'login', forged)).toBe(true); // one RPC is trusted for smart wallets...
    expect(await verifyWalletSignature([liar, 'http://127.0.0.1:1'], owner.address, 'login', forged)).toBe(false); // ...but every RPC must agree
    expect(await verifyEoaSignature(owner.address, 'login', forged)).toBe(false); // and the signer (key export) never asks
  });
});
