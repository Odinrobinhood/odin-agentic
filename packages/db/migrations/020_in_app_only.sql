-- User decision 2026-11-10: no external notification channels (Telegram removed); alerts are in-app only.
-- Stored chat ids are deleted so nothing can be sent to them if a channel is ever re-added.
DELETE FROM notification_channels;
UPDATE rule_alerts SET channels = '{}' WHERE channels <> '{}';
UPDATE signal_profiles SET channels = '{}' WHERE channels <> '{}';
