-- API Service (architecture §3.2): SIWE nonces and sessions.

-- Single-use, short-lived SIWE nonces.
CREATE TABLE siwe_nonces (
  nonce      text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- One row per refresh token. Rotation keeps the family: reusing a rotated token revokes the whole family
-- (stolen-token detection). Only the SHA-256 of the token is stored.
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  family     uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON sessions (family);

-- A user's last successful SIWE signature time, for step-up checks (withdraw, key export, going live).
ALTER TABLE users ADD COLUMN last_siwe_at timestamptz;
