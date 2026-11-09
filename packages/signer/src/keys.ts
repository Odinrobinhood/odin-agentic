import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hkdf } from '@noble/hashes/hkdf';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, type Hex } from 'viem';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SALT = new TextEncoder().encode('odin-agentic/agent-key/v1');
export const MIN_SEED_BYTES = 32;

/**
 * Read the master seed, refusing to start if the file or its directory is readable by anyone
 * but the owner (architecture §6: file 0400, dir 0700).
 */
export function readSeed(file: string, opts: { skipPermissionCheck?: boolean } = {}): Uint8Array {
  if (!opts.skipPermissionCheck && process.platform !== 'win32') {
    const f = statSync(file);
    const d = statSync(path.dirname(file));
    if ((f.mode & 0o277) !== 0) throw new Error(`seed file ${file} must be mode 0400 (is ${(f.mode & 0o777).toString(8)})`);
    if ((d.mode & 0o077) !== 0) throw new Error(`seed dir must be mode 0700 (is ${(d.mode & 0o777).toString(8)})`);
    if (typeof process.getuid === 'function' && f.uid !== process.getuid()) throw new Error('seed file must be owned by the signer user');
  }
  const seed = new Uint8Array(readFileSync(file));
  if (seed.length < MIN_SEED_BYTES) throw new Error(`seed must be at least ${MIN_SEED_BYTES} bytes`);
  return seed;
}

/** Derive the agent's private key: HKDF-SHA512(seed, salt, info = "agent:<index>[:<counter>]"). */
export function deriveAgentKey(seed: Uint8Array, derivationIndex: bigint): Hex {
  if (derivationIndex < 0n) throw new Error('derivation index must be >= 0');
  for (let counter = 0; counter < 256; counter++) {
    const info = new TextEncoder().encode(counter === 0 ? `agent:${derivationIndex}` : `agent:${derivationIndex}:${counter}`);
    const okm = hkdf(sha512, seed, SALT, info, 32);
    const k = BigInt(bytesToHex(okm));
    if (k > 0n && k < SECP256K1_N) return bytesToHex(okm);
  }
  throw new Error('could not derive a valid key');
}
