-- Guard Watcher (architecture §3.10). Runs as its own OS user (odin-guard) with its own DB role, so the
-- guard channel token and the guard's DB rights are not available to the API/runtime processes.
CREATE INDEX ON guards (state) WHERE state = 'armed';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odin_guard') THEN
    GRANT USAGE ON SCHEMA public TO odin_guard;
    -- read what risk, routing and position valuation need
    GRANT SELECT ON agents, agent_wallets, agent_configs, agent_assets, tokens, routes, risk_profiles, tp_sl_defaults,
                    market_snapshots, rejections TO odin_guard;
    -- guard exits: decision + rejection records, executions and nonces, paper fills, positions, guard state, alerts
    GRANT SELECT, INSERT ON decisions, paper_fills, alert_events, risk_day_baselines TO odin_guard;
    GRANT INSERT ON rejections TO odin_guard;
    GRANT SELECT, INSERT, UPDATE ON executions, wallet_nonces, positions TO odin_guard;
    GRANT SELECT, UPDATE ON guards TO odin_guard;
  END IF;
END $$;
