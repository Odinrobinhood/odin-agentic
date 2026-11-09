import { getAddress, isAddress, type Address } from 'viem';

/**
 * The exact text a user signs to export an agent wallet's private key (architecture §6). The signer parses
 * and verifies it itself, so a compromised API cannot export keys without the owner's wallet signature.
 */
export type ExportMessage = { wallet: Address; agentId: string; chainId: number; nonce: string; expiresAt: Date };

export const EXPORT_MAX_TTL_SECONDS = 600;

export function exportKeyMessage(m: ExportMessage): string {
  return [
    'Odin Agentic: export the private key of my agent wallet.',
    'Anyone holding this key controls the wallet and its funds.',
    `Wallet: ${getAddress(m.wallet)}`,
    `Agent: ${m.agentId}`,
    `Chain ID: ${m.chainId}`,
    `Nonce: ${m.nonce}`,
    `Expires: ${m.expiresAt.toISOString()}`,
  ].join('\n');
}

const PATTERN =
  /^Odin Agentic: export the private key of my agent wallet\.\nAnyone holding this key controls the wallet and its funds\.\nWallet: (0x[0-9a-fA-F]{40})\nAgent: ([0-9a-f-]{36})\nChain ID: ([0-9]+)\nNonce: ([0-9a-zA-Z]{16,64})\nExpires: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** Strict parse: the whole message must match the template exactly, or null. */
export function parseExportKeyMessage(text: string): ExportMessage | null {
  const m = PATTERN.exec(text);
  if (!m || !isAddress(m[1]!)) return null;
  const expiresAt = new Date(m[5]!);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return { wallet: getAddress(m[1]!), agentId: m[2]!, chainId: Number(m[3]), nonce: m[4]!, expiresAt };
}
