-- Robinhood Stock Tokens expose paused() and tokenPaused() (verified on-chain 2026-11-10: beacon proxies of
-- 0xe10b6f6b275de231345c20d14ab812db62151b00); there is no isBlocked(address). Re-read catalog metadata so the
-- Stock Token flag uses the corrected probe.
UPDATE token_catalog SET meta_at = NULL WHERE meta_at IS NOT NULL;
