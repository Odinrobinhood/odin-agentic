import { createPublicClient, http, isAddressEqual, recoverMessageAddress, type Address, type Hex } from 'viem';

/**
 * EOA check by local ECDSA recovery only. viem's client.verifyMessage asks the RPC (universal validator
 * eth_call) FIRST, even for plain EOAs, so a lying RPC could approve any signature. This never asks the chain.
 */
export async function verifyEoaSignature(address: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    return isAddressEqual(await recoverMessageAddress({ message, signature }), address);
  } catch {
    return false;
  }
}

/**
 * Wallet signature check that does not trust a single RPC: EOAs are verified locally; a smart wallet
 * (ERC-1271 / ERC-6492) is accepted only when EVERY configured RPC independently reports it valid.
 */
export async function verifyWalletSignature(rpcUrls: string[], address: Address, message: string, signature: Hex): Promise<boolean> {
  if (await verifyEoaSignature(address, message, signature)) return true;
  if (rpcUrls.length === 0) return false;
  const verdicts = await Promise.all(
    rpcUrls.map(async (url) => {
      try {
        return await createPublicClient({ transport: http(url, { timeout: 10_000, retryCount: 1 }) }).verifyMessage({ address, message, signature });
      } catch {
        return false;
      }
    }),
  );
  return verdicts.every(Boolean);
}
