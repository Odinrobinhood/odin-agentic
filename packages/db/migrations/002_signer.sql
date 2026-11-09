-- Signer ledger (architecture §3.8): every signature is recorded atomically before it is returned.
CREATE TABLE signer_signatures (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id   uuid NOT NULL REFERENCES agents(id),
  channel    text NOT NULL CHECK (channel IN ('agent', 'guard')),
  kind       text NOT NULL CHECK (kind IN ('approve', 'swap')),
  day        date NOT NULL,
  tx_hash    text NOT NULL UNIQUE,
  nonce      bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON signer_signatures (agent_id, channel, day);

-- The signer's DB role (created during provisioning) may read only what it needs to enforce policy,
-- and may only append to its own ledger.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odin_signer') THEN
    GRANT USAGE ON SCHEMA public TO odin_signer;
    GRANT SELECT ON agents, agent_wallets, agent_assets, agent_configs, tokens, positions TO odin_signer;
    GRANT SELECT, INSERT ON signer_signatures TO odin_signer;
  END IF;
END $$;
