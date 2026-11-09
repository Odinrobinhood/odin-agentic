-- Agent Runtime + Scheduler (architecture §3.3, §3.4).

-- Live or paper. New agents start in paper mode; going live is an explicit user action.
ALTER TABLE agents ADD COLUMN mode run_mode NOT NULL DEFAULT 'paper';

-- One row per agent the scheduler drives. The lease guarantees one worker per agent at a time.
CREATE TABLE agent_schedule (
  agent_id           uuid PRIMARY KEY REFERENCES agents(id),
  next_tick_at       timestamptz NOT NULL DEFAULT now(),
  lease_owner        text,
  lease_until        timestamptz,
  last_tick_at       timestamptz,
  consecutive_errors integer NOT NULL DEFAULT 0,
  last_error         text
);
CREATE INDEX ON agent_schedule (next_tick_at);

-- Paper fills: simulated at the quoter's realizable output (fees and price impact included).
CREATE TABLE paper_fills (
  decision_id uuid PRIMARY KEY REFERENCES decisions(id),
  token_in    address NOT NULL,
  token_out   address NOT NULL,
  amount_in   uint256 NOT NULL,
  amount_out  uint256 NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
