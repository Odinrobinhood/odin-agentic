-- When the current position was opened (qty went from 0 to > 0). The model gets it as opened_at / held_minutes,
-- so holding-time rules ("sell after 20 minutes") do not depend on the model reading its own decision history.
-- NULL = unknown (positions opened before this migration) or closed.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS opened_at timestamptz;

-- Open live positions: the latest confirmed buy swap of that token (a later bound if it was built by several buys).
UPDATE positions p
   SET opened_at = (SELECT max(e.updated_at) FROM executions e JOIN decisions d ON d.id = e.decision_id
                     WHERE d.agent_id = p.agent_id AND d.token_address = p.token_address AND d.action = 'buy'
                       AND e.kind = 'swap' AND e.status = 'confirmed')
 WHERE p.qty > 0 AND p.opened_at IS NULL AND p.mode = 'live';
