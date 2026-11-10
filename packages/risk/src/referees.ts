import { readFileSync } from 'node:fs';
import { getAddress, type Address } from 'viem';
import type { RefereeSource } from './chain.ts';

/**
 * Referee sources for risk check 5. USDG is the unit of account (fixed 1 USD); every other entry comes
 * from the verified feed map (deploy/chainlink.mainnet.json, built by scripts/chainlink-feeds.ts).
 * A missing file means only USDG has a referee; a malformed file is an error (never silently skipped).
 */
export function loadReferees(file: string | undefined, usdg: Address): Map<Address, RefereeSource> {
  const m = new Map<Address, RefereeSource>([[getAddress(usdg), { fixedUsd: 1 }]]);
  if (!file) return m;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { feeds?: unknown };
  if (!Array.isArray(raw.feeds)) throw new Error(`${file}: "feeds" must be an array`);
  for (const e of raw.feeds as Record<string, unknown>[]) {
    const token = getAddress(String(e.token));
    const feed = getAddress(String(e.feed));
    const maxAgeSeconds = Number(e.maxAgeSeconds);
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error(`${file}: bad maxAgeSeconds for ${token}`);
    if (m.has(token)) throw new Error(`${file}: duplicate referee for ${token}`);
    m.set(token, { feed, maxAgeSeconds });
  }
  return m;
}
