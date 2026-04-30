-- 0006_subscriptions_language.sql
-- Hotfix discovered during Sprint 1 verification:
--   parent.ts (POST /preferences UPDATE), publish/index.ts (subscriber SELECT)
--   both reference subscriptions.language, but the column was never added.
--   Without it, /preferences POST and any flyer fan-out 500. Adding the
--   column with default 'en' so existing opt-in rows pick up a sane value.

ALTER TABLE subscriptions ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
