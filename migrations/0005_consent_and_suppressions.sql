-- 0005_consent_and_suppressions.sql
-- TCPA / CAN-SPAM evidence trail for §2.6 subscriber opt-in.
-- consent_log records every opt-in/opt-out/preference change with the exact
-- policy version the subscriber agreed to.
-- suppressions is the email/phone block list (STOP, complaints, hard bounces).

CREATE TABLE IF NOT EXISTS consent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER,
  email TEXT NOT NULL,
  channel TEXT NOT NULL,                 -- email | sms | emergency
  action TEXT NOT NULL,                  -- optin | verify | optout | preference_change
  language_version TEXT NOT NULL,        -- the policy version they agreed to
  source_url TEXT,
  ip TEXT,
  user_agent TEXT,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

CREATE INDEX IF NOT EXISTS idx_consent_email ON consent_log(email, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_subscription ON consent_log(subscription_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS suppressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                 -- email | sms
  identifier TEXT NOT NULL,              -- email lowercase OR phone E.164
  reason TEXT,                           -- stop | bounce | complaint | manual
  recorded_at INTEGER NOT NULL,
  UNIQUE(channel, identifier)
);

CREATE INDEX IF NOT EXISTS idx_suppressions_channel ON suppressions(channel, identifier);
