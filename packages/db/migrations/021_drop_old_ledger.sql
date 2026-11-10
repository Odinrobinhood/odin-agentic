-- The signer ledger and export nonces live in the vault schema `signer` since migration 018 (rows copied there).
-- The old app-writable tables are no longer read or written by anything.
DROP TABLE signer_signatures;
DROP TABLE signer_exports;
