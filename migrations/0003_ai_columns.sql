-- 0003_ai_columns.sql
-- Adds the AI pipeline output columns introduced in CODEX_BRIEF §2.3.
-- ALTER TABLE in D1 is single-statement-per-call; keeping each on its own line
-- so a partial apply leaves the schema in a known state.

ALTER TABLE flyers ADD COLUMN title_es TEXT;
ALTER TABLE flyers ADD COLUMN summary_es TEXT;
ALTER TABLE flyers ADD COLUMN body_html_es TEXT;
ALTER TABLE flyers ADD COLUMN ai_verdict_json TEXT;
ALTER TABLE flyers ADD COLUMN prompt_version TEXT;
ALTER TABLE flyers ADD COLUMN ai_processed_at INTEGER;
