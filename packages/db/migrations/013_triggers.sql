-- Agent price triggers (architecture §3.5): wake an agent outside its cadence when a condition starts to hold.

-- Why the next tick was pulled forward; read (and cleared) by the runtime and shown to the model.
ALTER TABLE agent_schedule ADD COLUMN wake_reason jsonb;

-- Edge detection per trigger: fire when a condition becomes true, re-arm when it is false again.
-- Tied to the config version: a new version starts every trigger armed.
CREATE TABLE agent_trigger_state (
  agent_id       uuid NOT NULL REFERENCES agents(id),
  idx            integer NOT NULL,
  config_version integer NOT NULL,
  holding        boolean NOT NULL,
  last_fired_at  timestamptz,
  PRIMARY KEY (agent_id, idx)
);
