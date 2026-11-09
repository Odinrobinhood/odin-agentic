-- Notifier (architecture §3.11).

ALTER TABLE alert_events
  ADD COLUMN user_id        uuid REFERENCES users(id),
  ADD COLUMN delivered_at   timestamptz,
  ADD COLUMN attempts       integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_error     text;
CREATE INDEX ON alert_events (next_attempt_at) WHERE delivered_at IS NULL;
CREATE INDEX ON alert_events (user_id, created_at DESC);

-- Every producer (guard watcher, runtime, signals) only knows the agent: resolve the owner on insert.
CREATE FUNCTION alert_events_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NULL AND NEW.payload ? 'agentId' THEN
    SELECT user_id INTO NEW.user_id FROM agents WHERE id = (NEW.payload->>'agentId')::uuid;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alert_events_owner BEFORE INSERT ON alert_events FOR EACH ROW EXECUTE FUNCTION alert_events_owner();

UPDATE alert_events e SET user_id = a.user_id FROM agents a WHERE e.user_id IS NULL AND a.id = (e.payload->>'agentId')::uuid;
-- events created before the notifier existed are not re-sent
UPDATE alert_events SET delivered_at = created_at, delivered_channels = '{in_app}' WHERE delivered_at IS NULL;

-- Per-user delivery channels. In-app delivery is always on (the feed reads alert_events).
CREATE TABLE notification_channels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('telegram')),
  target     text NOT NULL CHECK (char_length(target) <= 200),
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind)
);

ALTER TABLE alert_events DROP CONSTRAINT alert_events_source_check;
ALTER TABLE alert_events ADD CONSTRAINT alert_events_source_check CHECK (source IN ('rule', 'signal', 'guard', 'system', 'runtime'));
