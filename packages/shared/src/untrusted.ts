/**
 * Contract-supplied strings (symbol(), name(), ...) are attacker-controlled (architecture §2.5, §3.5).
 * They are cleaned and truncated here, and must only ever be placed inside a delimited data block
 * of a prompt, never concatenated into instructions.
 */
export const LABEL_LIMITS = { symbol: 16, name: 64 } as const;

// Control chars, zero-width/bidi/format chars, private use, unassigned, surrogates, line/paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu;

export function sanitizeLabel(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.normalize('NFKC').replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, max).join('');
}

export function sanitizeSymbol(raw: unknown): string {
  return sanitizeLabel(raw, LABEL_LIMITS.symbol);
}

export function sanitizeName(raw: unknown): string {
  return sanitizeLabel(raw, LABEL_LIMITS.name);
}

/**
 * Serialize untrusted data for a prompt: a JSON document wrapped in explicit markers that the
 * system prompt declares as data-only. '<' and '>' are JSON-escaped so a value can never contain
 * a marker and close the block early.
 */
export function untrustedDataBlock(label: string, data: unknown): string {
  const json = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  return `<<<DATA ${label}\n${json}\nDATA>>>`;
}
