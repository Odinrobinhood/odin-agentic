-- Security review 2026-11-10 (API):
-- * step-up ("SIWE < 10 min") is per session family, not per user: signing in on one device must not
--   unlock withdraw / live mode for an older (possibly stolen) session of the same user.
-- * absolute session lifetime: rotation no longer extends a family past its first login + 30 days.
ALTER TABLE sessions ADD COLUMN siwe_at timestamptz;
ALTER TABLE sessions ADD COLUMN family_expires_at timestamptz;
UPDATE sessions SET family_expires_at = expires_at WHERE family_expires_at IS NULL;
ALTER TABLE sessions ALTER COLUMN family_expires_at SET NOT NULL;
-- used SIWE nonces are kept a day for forensics, then purged by the API
CREATE INDEX ON siwe_nonces (expires_at);
