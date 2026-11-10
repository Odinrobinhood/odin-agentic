-- Signer vault (security review 2026-11-10). The app role `odin` owns every public table, so anything the
-- signer trusted there (agent -> owner, agent -> derivation index, ledger, export nonces) could be rewritten
-- by any compromised app service: re-point an agent at a victim's key index and export it, change an
-- agent's owner and withdraw to it, or delete ledger rows to reset caps.
--
-- Schema `signer` holds what the signer must be able to trust. Provisioning (as postgres, after migrations)
-- hands it to the NOLOGIN role `odin_vault`; the signer role may only SELECT and INSERT (append-only), the
-- app role may only SELECT. Schema changes here must therefore be applied by provisioning, not as `odin`.
CREATE SCHEMA signer;

-- Immutable agent -> wallet -> owner binding, written by the signer the first time it sees an agent wallet
-- (after checking the derived address matches). Index and wallet are unique across all agents.
CREATE TABLE signer.wallet_bindings (
  agent_id         uuid PRIMARY KEY,
  derivation_index bigint NOT NULL UNIQUE CHECK (derivation_index >= 0),
  wallet           text NOT NULL UNIQUE,
  owner            text NOT NULL,
  bound_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE signer.signatures (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id   uuid NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('agent', 'guard')),
  kind       text NOT NULL CHECK (kind IN ('approve', 'swap', 'withdraw')),
  day        date NOT NULL,
  tx_hash    text NOT NULL UNIQUE,
  nonce      bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON signer.signatures (agent_id, channel, day);

CREATE TABLE signer.exports (
  nonce       text PRIMARY KEY,
  agent_id    uuid NOT NULL,
  exported_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO signer.signatures (agent_id, channel, kind, day, tx_hash, nonce, created_at)
  SELECT agent_id, channel, kind, day, tx_hash, nonce, created_at FROM signer_signatures ORDER BY id;
INSERT INTO signer.exports (nonce, agent_id, exported_at) SELECT nonce, agent_id, exported_at FROM signer_exports;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odin_signer') THEN
    GRANT USAGE ON SCHEMA signer TO odin_signer;
    GRANT SELECT, INSERT ON signer.wallet_bindings, signer.signatures, signer.exports TO odin_signer;
    -- binding reads the current owner once; afterwards only the vault is trusted
    GRANT SELECT (id, user_id) ON agents TO odin_signer;
  END IF;
END $$;
