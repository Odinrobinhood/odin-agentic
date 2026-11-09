-- Withdraw, key export and close-all (architecture §6, §10).

ALTER TYPE execution_kind ADD VALUE IF NOT EXISTS 'withdraw';

-- Withdrawals are not decisions: executions may reference an agent directly instead.
ALTER TABLE executions ALTER COLUMN decision_id DROP NOT NULL;
ALTER TABLE executions ADD COLUMN agent_id uuid REFERENCES agents(id);
UPDATE executions e SET agent_id = d.agent_id FROM decisions d WHERE d.id = e.decision_id;
ALTER TABLE executions ADD CONSTRAINT executions_has_owner CHECK (decision_id IS NOT NULL OR agent_id IS NOT NULL);

ALTER TABLE signer_signatures DROP CONSTRAINT signer_signatures_kind_check;
ALTER TABLE signer_signatures ADD CONSTRAINT signer_signatures_kind_check CHECK (kind IN ('approve', 'swap', 'withdraw'));

-- A withdrawal always goes to the owner's SIWE wallet; the signer reads that address itself.
CREATE TABLE withdrawals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES agents(id),
  token      address,              -- NULL = native ETH
  amount     uint256 NOT NULL CHECK (amount > 0),
  recipient  address NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'reverted', 'dropped', 'rejected')),
  tx_hash    text,
  error_code text,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON withdrawals (agent_id, created_at DESC);

-- Key exports: the signer verifies the owner's signature itself and burns the nonce here.
CREATE TABLE signer_exports (
  nonce       text PRIMARY KEY,
  agent_id    uuid NOT NULL REFERENCES agents(id),
  exported_at timestamptz NOT NULL DEFAULT now()
);

-- "Close all positions": requested by the user through the API, executed by the guard watcher on the
-- signer's guard channel (the API never holds that token).
CREATE TABLE close_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id),
  mode         run_mode NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'partial')),
  result       jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX ON close_requests (status) WHERE status = 'pending';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odin_signer') THEN
    -- the owner's address is the only withdrawal recipient and the only key-export authority
    GRANT SELECT (id, wallet_address) ON users TO odin_signer;
    GRANT SELECT, INSERT ON signer_exports TO odin_signer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odin_guard') THEN
    GRANT SELECT, UPDATE ON close_requests TO odin_guard;
  END IF;
END $$;
