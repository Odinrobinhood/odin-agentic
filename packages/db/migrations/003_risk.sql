-- Risk Engine (architecture §3.7): NAV baseline for the user's optional max daily loss.
-- Recorded at the agent's first evaluation of each UTC day, in whole quote-asset units.
CREATE TABLE risk_day_baselines (
  agent_id   uuid NOT NULL REFERENCES agents(id),
  mode       run_mode NOT NULL,
  day        date NOT NULL,
  nav_quote  numeric NOT NULL CHECK (nav_quote >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, mode, day)
);
