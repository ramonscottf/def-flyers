-- 0004_publishing.sql
-- Adds the scheduling column for §2.5 publishing.
-- The rendered HTML keys are conventional (flyers/{slug}/index.html and
-- /index.es.html) so we don't need columns for them.

ALTER TABLE flyers ADD COLUMN scheduled_send_at INTEGER;
