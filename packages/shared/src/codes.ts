/**
 * Machine-readable rejection codes. Every rejection carries one of these all the way to the UI
 * (architecture §2 "Fail loudly").
 */
export const REJECTION_CODES = [
  // auth / transport
  'unauthorized',
  'bad_request',
  // agent state
  'unknown_agent',
  'agent_not_active',
  'agent_retired',
  // token & route
  'token_not_allowed',
  'quote_not_allowed',
  'invalid_path',
  'bad_fee_tier',
  'intermediate_not_allowed',
  'guard_must_sell_to_quote',
  'no_pool',
  'token_paused',
  'wallet_blocked',
  // amounts
  'amount_invalid',
  'min_out_zero',
  'approval_too_large',
  // gas
  'gas_limit_exceeded',
  'fee_cap_exceeded',
  // caps
  'signature_cap_reached',
  // chain
  'chain_mismatch',
  'chain_read_failed',
  // risk engine
  'insufficient_balance',
  'insufficient_gas',
  'exceeds_position_limit',
  'exceeds_exposure_limit',
  'exceeds_trades_per_day',
  'exceeds_daily_loss',
  'price_deviation',
  // executor
  'broadcast_failed',
  'nonce_conflict',
  'tx_expired',
  'tx_reverted',
  'tx_timeout',
  'approve_failed',
  'signer_unavailable',
  'internal_error',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

export class Rejection extends Error {
  readonly code: RejectionCode;
  constructor(code: RejectionCode, message: string) {
    super(message);
    this.name = 'Rejection';
    this.code = code;
  }
}
