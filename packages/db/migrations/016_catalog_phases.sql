-- Catalog enrichment in two phases: depth for every token with a USDG/WETH pool (batched, cheap), then
-- metadata only for tokens with real depth. Robinhood Chain has ~10^5+ launchpad pools, most of them empty.
ALTER TABLE token_catalog ALTER COLUMN symbol SET DEFAULT '';
ALTER TABLE token_catalog ALTER COLUMN name SET DEFAULT '';
ALTER TABLE token_catalog ADD COLUMN depth_checked_at timestamptz;
ALTER TABLE token_catalog ADD COLUMN meta_at timestamptz;
UPDATE token_catalog SET depth_checked_at = enriched_at, meta_at = CASE WHEN error IS NULL THEN enriched_at END;
CREATE INDEX ON token_catalog (depth_checked_at);
CREATE INDEX ON discovered_pools (token0, token1);
