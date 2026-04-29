# DEF Flyers — Build Handoff
**Project codename:** Skippy / DEF Flyers
**Repo:** `ramonscottf/def-flyers`
**Domain:** `flyers.daviskids.org` (everything — single Worker serves UI + API + short links)
**Owner:** Scott Foster (DEF) · **Build agent:** Codex
**Synthesis date:** April 29, 2026
**Status:** Phase 0 (governance) starts now. Phase 1 (MVP) begins after Phase 0 sign-off.

---

## 0. What this document is

This is a synthesis. Two long research plans were generated, plus Codex's review of both. Codex's verdict: **Plan 2 is the stronger build plan, Plan 1 has the stronger product vision, and neither should be built as written.** This doc is the third hybrid plan — Plan 2's operational grounding plus Plan 1's parent-first, accessibility-first product thinking, with all of Codex's guardrails applied.

The product replaces two channels DEF already owns:
1. **Peachjar** — community-org → parent flyers (~$2,300/district-wide flyer at $25 × 92 schools)
2. **DSD Ads** — sponsor-paid emails to ~8,000 DSD employees (gala packages: Gold $7,500 = 1 send; Platinum $10,000 = 2)

Both ride the same submit → review → publish → notify → measure loop. Build the audience model abstract from day one — parents and employees are two tenants of one system, not two products.

---

## 1. Non-negotiables (read these first)

These come straight from Codex's review and Scott's operating principles. If a later section contradicts them, these win.

1. **Phase 0 (governance) ships before Phase 1 (code).** Peachjar contract review, DPA, sender-of-record decision, flyer/sponsor/privacy/TCPA policy, accessibility statement, Twilio 10DLC submission. No parent data moves until these exist.
2. **AI assists, does not decide.** Every flyer gets human review at launch. Auto-publish "green-lane" only ships after we have local evidence the AI is right.
3. **HTML-first, PDF supplemental.** Submitters fill structured fields *before* uploading. The published artifact is accessible HTML. Original PDF is stored in R2 as evidence/attachment, never as the canonical render.
4. **Separate Stripe account for flyer revenue.** DEF's existing Stripe runs donations and qualifies for the 2.2% nonprofit rate only if >80% of volume is tax-deductible. Flyer revenue is not a donation. Open a second Stripe account at standard 2.9% + $0.30. Do not co-mingle.
5. **Twilio Charity 10DLC submission goes in on Day 1 of Phase 1.** Approval takes 2–4 weeks. SMS does not exist as a feature until the campaign shows APPROVED. Do not promise launch dates that depend on it.
6. **Provider abstractions for AI and SMS.** AI client wrapper takes a provider arg (`anthropic` | `cf-workers-ai`); SMS client wrapper takes a provider arg (`twilio` | `telnyx`). Start with Anthropic Claude (Sonnet 4.6 + Haiku 4.5) and Twilio. Do not hardcode either.
7. **DEF is the contracting party with parents, not DSD.** Peachjar's vendor lock-in clause forbids the *district* from running an alternative free channel. The Foundation is a separate 501(c)(3) and can. Every parent-facing surface reads "from Davis Education Foundation, in partnership with Davis School District."
8. **WCAG 2.1 AA at launch.** The DOJ April 20, 2026 IFR moved the Title II deadline to April 26, 2027 — but Section 504 and private litigation apply now. Build to AA. Axe-core in CI from day one.
9. **TCPA: full Prior Express Written Consent, double opt-in, STOP honored within 10 business days.** No bundling fundraising into informational SMS. Sweepstakes only — never the word "raffle" (Utah Code §76-10-1101).
10. **No `sed` on production HTML.** CSS-only edits, reviewed before deploy. Standing Skippy rule, applies here.
11. **No two Claude/Codex sessions pushing the same repo simultaneously.** Standing rule.

---

## 2. Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│  flyers.daviskids.org   ←  Cloudflare Pages (Astro SSR)    │
│  go.daviskids.org        ←  separate small Worker           │
└─────────────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│  def-flyers-api  (Hono Worker, single entrypoint)          │
│  ─ public, submitter (magic link), parent (magic link),     │
│    admin (Entra ID OIDC), webhooks                          │
└─────────────────────────────────────────────────────────────┘
                  │
   ┌──────────────┼──────────────┬──────────────┐
   ▼              ▼              ▼              ▼
 D1            R2 (raw +       Queues         KV
 (single DB)   rendered)       (4)            (sessions,
                                              shortlinks,
                                              rate-limit)
   │              │              │
   │              │              ├─→ def-ai-pipeline    (Anthropic/CF AI)
   │              │              ├─→ def-email-batch    (Postmark / SES)
   │              │              ├─→ def-sms-batch      (Twilio, throttled)
   │              │              └─→ def-webhook-events (Stripe, Postmark, SES, Twilio)
   │
   └─→ Vectorize: skippy-memory (768-dim, cosine, bge-base-en-v1.5)
        ↑ confirmed dim, do not switch embedders without re-indexing
```

**Stack pinned:**
- Cloudflare Workers, `compatibility_date = "2026-04-29"`, `nodejs_compat`
- Hono ^4.x (router)
- Astro + Tailwind for the marketing/parent/submitter UI (Cloudflare Pages adapter)
- Drizzle ORM ^0.36 over D1
- HTMX 2.0.4 + Alpine.js 3.14 for admin/parent interactions where SSR isn't enough
- React Email for templates, compiled to inline-styled HTML
- `@anthropic-ai/sdk`, `twilio` SDK, `stripe` SDK, `jose` for OIDC
- axe-core via Playwright in CI nightly + on every PR

**Why Astro + Hono and not Pages Functions only:** the parent-facing flyerboard ships zero JS by default (full SSG/SSR, indexable, accessible without JS). The pipeline lives in a dedicated Worker so the AI Queue Consumer has the 15-minute CPU budget; the inbound HTTP Worker is fast and never blocks on AI.

---

## 3. Phase plan

### Phase 0 — Governance (1–2 weeks, no code yet)

Codex was emphatic: do this first. None of it is Codex's job to ship. Scott drives.

- [ ] **Peachjar contract review.** Termination clause, vendor lock-in language, current credit balance. Determine whether DEF can run Connect in parallel or whether it must wait for the Peachjar agreement to expire.
- [ ] **Sender-of-record decision.** Is DEF or DSD the controller of parent data? Recommendation: **DEF**, because Peachjar's vendor lock-in clause binds the *district*, and DEF as a separate 501(c)(3) is not bound. Confirm with district counsel.
- [ ] **DPA.** Execute or confirm a Data Processing Agreement consistent with Utah Code § 53E-9-309 if any SIS or roster data flows. Use SDPC Utah Alliance template. Davis SD is a member.
- [ ] **FERPA notice.** Confirm Davis SD's annual FERPA notice covers DEF as a "school official" (or contractor performing district communications). If it doesn't, Phase 1 cannot pull from SIS — parents opt in directly through marketing channels.
- [ ] **Policies drafted, reviewed, and posted at /policies on flyers.daviskids.org before launch:**
  - Flyer policy (eligibility tiers, prohibited content, decision criteria, appeals)
  - Sponsor policy (placement rules, non-endorsement language)
  - Privacy policy (data collected, retention, sharing, parent rights)
  - TCPA consent language (versioned — every change gets a new version number stored in `consent_log`)
  - WCAG 2.1 AA conformance statement (per the Section 508 ICT Accessibility Statement template)
- [ ] **Twilio Trust Hub Customer Profile filed as Non-Profit; NON_PROFIT brand submitted; Charity 501(c)(3) campaign vetting submitted with sample messages, opt-in screencast, T&C URLs.** This is the *only* code-adjacent task in Phase 0 because the carrier review clock is 2–4 weeks and we want it ticking.
- [ ] **Microsoft Entra app registration request** sent to Michael Bateman (mbateman@dsdmail.net). Redirect URI: `https://flyers.daviskids.org/auth/callback`. Group claims required for role assignment.
- [ ] **Confirm current dsdads workflow.** Scott pulls from inside DEF: what platform actually sends today (district mail server, Constant Contact, Mailchimp, M365 distribution group), how submission happens today, who approves, what a current sponsor pays.
- [ ] **Confirm `skippy-memory` dimension.** Per Scott's memory: 768-dim, bge-base-en-v1.5. This is the embedder we use. Do not switch without re-indexing.
- [ ] **Get rate-card sign-off from Sherry Miggin and Kara Toone.** Tier table is in §10 below. Do not ship pricing without their go.

**Exit criteria:** all checkboxes above closed; 10DLC campaign submitted (not approved — submitted is enough); Bateman has the Entra request in hand; Sherry/Kara have signed off on tiers.

### Phase 1 — MVP (4–6 weeks)

Ship only the core loop. **Email-only at launch.** SMS is Phase 2. Codex was explicit: do not build the Parent Hub, two-way chat, MMS, or advanced sponsor portal in Phase 1.

**Scope:**
- Submitter portal (magic-link auth via email; no submitter accounts/passwords)
- **Structured-fields-first, upload-second** submission flow (title, date, time, location, body text, audience, registration URL, contact — all required; PDF/image upload is supplemental evidence, never the canonical render)
- AI ingest pipeline (Queue Consumer) — Sonnet 4.6 vision for OCR/extraction/alt-text/image-of-text detection, Haiku 4.5 for moderation/translation/SMS condensing, Worker JS for WCAG contrast math
- Reviewer queue with green/yellow/red lanes — **every flyer requires human approval at launch.** No auto-publish.
- HTML-first rendered output stored in R2, served from `flyers.daviskids.org/flyer/:id` with EN/ES toggle
- Public flyer board at `flyers.daviskids.org/board` (and `/board?school=:id`), HTMX-driven filters, fully indexable static-first
- Email distribution via **Postmark for transactional + AWS SES for bulk** (Resend listed in earlier plans — we are not using Resend for bulk; SES has better economics above 250K/mo and is what Codex's plan calls for)
- Stripe Checkout (separate account, test mode → live)
- Parent email-only opt-in with verification, preference center skeleton (school, language, unsubscribe)
- Consent log, suppression list, audit log
- Axe-core CI gate (PRs blocked on AA violations)
- Replace `/advertise-peachjar.html` and `/advertise-dsd-ads.html` on daviskids.org with "Coming soon — submit at flyers.daviskids.org" landing pages

**Out of scope for Phase 1:**
- SMS (any kind)
- Auto-publish/green-lane
- DSD Ads tenant (employee channel — Phase 3)
- Sponsor self-service portal
- Two-way chat / RSVP / calendar add
- Parent Hub features
- MMS
- Apptegy iframe embeds

**Exit criteria:** end-to-end flyer flow works (vendor uploads → AI processes → reviewer approves → flyer renders accessible HTML in EN+ES → email digest sent to a test list → suppression and unsubscribe work). Two or three friendly local nonprofits piloted. Axe-core CI gate is green.

### Phase 2 — SMS + Parent Preferences (after 10DLC APPROVED)

Triggered by Twilio campaign showing APPROVED, not by a calendar date.

- Twilio Verify phone OTP
- Double opt-in SMS ("Reply YES to confirm")
- Parent preference center expansion: schools, grades, language, topics, channels, quiet hours (default 8 PM–8 AM), weekly cap (default 2), **emergency-only toggle**
- Branded short links at `go.daviskids.org/<slug>` — never generic shorteners (carrier-flagged)
- Sweepstakes-structured opt-in incentive ("NO PURCHASE NECESSARY," AMOE published) — never "raffle"
- 130-char Haiku-generated SMS summary per flyer
- Reviewer audit log surfaced in admin UI
- Sponsor attribution rendering on flyer cards
- IRS Pub 78 + 990 lookup automation for org tier verification
- **No MMS.** Defer indefinitely unless a specific use case proves it.

### Phase 3 — Replace Peachjar + DSD Ads (8+ weeks out)

- Rewrite `/advertise-peachjar.html` and `/advertise-dsd-ads.html` to point at the live submitter portal
- Launch Community Free + Local Nonprofit + Standard + Premium tiers (rate card in §10)
- **DSD Ads tenant** added as a second audience/channel in the same review system (employees ↔ parents, ad-vs-flyer disclaimer differs)
- Submitter analytics dashboard (deliveries, opens, clicks, school reach, language reach — Stripe-pattern)
- Apptegy iframe embeds + RSS/JSON feeds for school sites
- ICS calendar feed (one-tap add)
- Quarterly `delivery_events` archive cron to R2

### Phase 4 — Parent Hub expansion (post-90-day)

Only after the core loop has earned trust. Emergency alerts, event reminders, district announcements (≤4/mo total), volunteer signups, community calendar, A/B subject testing, RCS where carrier-supported. All gated on actual measured engagement, not roadmap pressure.

---

## 4. Cloudflare resources to create

Account: `77f3d6611f5ceab7651744268d434342` · Zone (daviskids.org): `e9aac6e9fab72eae9eda35335bc47f40`

| Resource | Name | Purpose |
|---|---|---|
| Pages project | `def-flyers` | Astro app, parent/submitter UI |
| Worker | `def-flyers-api` | Hono router, all API routes |
| Worker | `def-flyers-go` | `go.daviskids.org` short-link redirector |
| D1 database | `def-flyers-db` | Single DB, schema in §6 |
| R2 bucket | `def-flyers-flyers-raw` | Original uploads (PDF/PNG/JPG, evidence) |
| R2 bucket | `def-flyers-flyers-html` | Generated accessible HTML, EN + ES |
| R2 bucket | `def-flyers-archive` | Quarterly delivery_events archives |
| KV namespace | `def-flyers-sessions` | Session tokens, JWKs cache |
| KV namespace | `def-flyers-rate` | Rate-limit counters |
| KV namespace | `def-flyers-shortlinks` | `go.daviskids.org` slug → URL + click counter |
| Queue | `def-ai-pipeline` | AI fan-out for new flyers; max_batch_size=1, max_retries=3, DLQ |
| Queue | `def-email-batch` | Postmark + SES fan-out; max_batch_size=25 |
| Queue | `def-sms-batch` | Twilio fan-out, throttled to campaign MPS (Phase 2) |
| Queue | `def-webhook-events` | Stripe/Postmark/SES/Twilio webhook fan-out |
| Queue | `def-flyer-dlq` | Dead-letter for ai-pipeline |
| Vectorize index | `skippy-memory` | **Existing** — 768-dim, cosine, bge-base-en-v1.5. Do not re-create. |
| Cron | `daily-distribute` | 06:00 MT, builds + dispatches digests |
| Cron | `nightly-ada-rescan` | 02:00 MT, axe-core on published flyers |
| Cron | `quarterly-archive` | 1st of quarter, archives delivery_events to R2 |
| Email Routing | `submit@daviskids.org` | Inbound vendor submissions (Phase 3) |
| DNS | `flyers.daviskids.org` | → Pages |
| DNS | `go.daviskids.org` | → `def-flyers-go` Worker |
| DNS | `mail.daviskids.org` | SPF/DKIM/DMARC for Postmark + SES |
| DNS | `flyers.daviskids.org` | 301 reserved for SEO/legacy |

**Cloudflare auth rule (Skippy standing rule):** always use `X-Auth-Key` + `X-Auth-Email` (Global API Key) headers when scripting against the CF API. Never Bearer token. This has caused repeated failures historically.

---

## 5. Repo skeleton

```
def-flyers/
├── README.md
├── wrangler.toml
├── package.json
├── tsconfig.json
├── astro.config.mjs                  # @astrojs/cloudflare adapter
├── tailwind.config.ts
├── drizzle.config.ts
├── .github/workflows/
│   ├── ci.yml                        # typecheck + drizzle check + axe-core gate + tests
│   └── deploy.yml                    # wrangler deploy on main (Pages auto-deploys on push)
├── public/
│   ├── favicon.svg
│   └── robots.txt
├── src/
│   ├── pages/                        # Astro pages
│   │   ├── index.astro               # marketing landing
│   │   ├── board.astro               # parent flyerboard
│   │   ├── flyer/[id].astro          # single flyer, EN/ES toggle
│   │   ├── submit.astro              # submitter wizard (structured-first)
│   │   ├── submit/track/[id].astro   # status tracker
│   │   ├── parent.astro              # parent prefs + opt-in
│   │   ├── verify-email.astro
│   │   ├── unsubscribe.astro
│   │   ├── policies/
│   │   │   ├── flyer-policy.astro
│   │   │   ├── sponsor-policy.astro
│   │   │   ├── privacy.astro
│   │   │   ├── tcpa.astro
│   │   │   └── accessibility.astro
│   │   ├── admin/                    # Entra ID gated
│   │   │   ├── index.astro           # reviewer queue
│   │   │   ├── flyer/[id].astro      # detail + approve/reject
│   │   │   ├── sponsors.astro
│   │   │   └── metrics.astro
│   │   └── api/                      # Pages Functions, lightweight
│   │       └── health.ts
│   ├── components/
│   │   ├── FlyerCard.astro
│   │   ├── LanguageToggle.astro      # USWDS pattern, "English / Español"
│   │   ├── StatusTracker.tsx         # Preact island, 5s polling Phase 1
│   │   ├── PreferenceCenter.tsx
│   │   └── EmergencyOnlyToggle.tsx
│   ├── emails/                       # React Email
│   │   ├── FlyerDigest.tsx
│   │   ├── ConsentReceipt.tsx
│   │   ├── MagicLink.tsx
│   │   └── FlyerSingle.tsx
│   ├── server/                       # the Hono Worker
│   │   ├── index.ts                  # Hono app entrypoint
│   │   ├── routes/
│   │   │   ├── public.ts
│   │   │   ├── submitter.ts
│   │   │   ├── admin.ts
│   │   │   ├── parent.ts
│   │   │   ├── stripe.ts             # /api/stripe/checkout, /webhook/stripe
│   │   │   └── webhooks.ts           # postmark, ses, twilio
│   │   ├── auth/
│   │   │   ├── entra.ts              # OIDC PKCE for staff
│   │   │   ├── magicLink.ts          # parent + vendor
│   │   │   └── twilioVerify.ts       # phone OTP (Phase 2)
│   │   ├── ai/
│   │   │   ├── client.ts             # provider abstraction (anthropic | cf-workers-ai)
│   │   │   ├── prompts.ts            # versioned prompts, every change bumps version
│   │   │   ├── extract.ts            # Sonnet 4.6 vision: OCR + structured event JSON
│   │   │   ├── altText.ts            # Sonnet vision per region
│   │   │   ├── render.ts             # WCAG-compliant HTML gen
│   │   │   ├── translate.ts          # Haiku ES, Latin American neutral
│   │   │   ├── moderate.ts           # Haiku content moderation
│   │   │   ├── smsCondense.ts        # Phase 2
│   │   │   ├── contrast.ts           # WCAG luminance math (no AI)
│   │   │   └── embed.ts              # bge-base-en-v1.5 → skippy-memory
│   │   ├── notify/
│   │   │   ├── email.ts              # Postmark transactional + SES bulk
│   │   │   ├── sms.ts                # provider abstraction (twilio | telnyx); Phase 2
│   │   │   └── shortlinks.ts         # go.daviskids.org slug mgmt
│   │   ├── db/
│   │   │   ├── schema.ts             # Drizzle schema (mirrors §6)
│   │   │   ├── migrations/
│   │   │   │   └── 0001_init.sql
│   │   │   └── queries.ts
│   │   ├── queues/
│   │   │   ├── aiPipeline.ts         # consumer
│   │   │   ├── emailBatch.ts
│   │   │   ├── smsBatch.ts           # Phase 2
│   │   │   └── webhookEvents.ts
│   │   ├── crons/
│   │   │   ├── dailyDistribute.ts
│   │   │   ├── nightlyAdaRescan.ts
│   │   │   └── quarterlyArchive.ts
│   │   └── lib/
│   │       ├── jwt.ts
│   │       ├── rateLimit.ts
│   │       ├── audit.ts
│   │       ├── consent.ts            # consent_log writes, suppression checks
│   │       ├── tcpa.ts
│   │       └── wcag.ts               # axe-core wrapper
│   └── styles/
│       └── tailwind.css
├── tests/
│   ├── ai.spec.ts
│   ├── auth.spec.ts
│   ├── consent.spec.ts
│   ├── tcpa.spec.ts
│   ├── wcag.spec.ts                  # axe-core against rendered HTML
│   └── pipeline.spec.ts
└── docs/
    ├── ACCESSIBILITY.md
    ├── TCPA.md
    ├── BUILD.md
    └── RUNBOOK.md
```

---

## 6. D1 schema (initial migration)

Single database. Drizzle schema in `src/server/db/schema.ts` mirrors this. Migrate via `wrangler d1 migrations apply def-flyers-db`.

```sql
-- migrations/0001_init.sql

-- ─── Organizations & schools ───────────────────────────────────────────────
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,                   -- ulid
  name TEXT NOT NULL,
  ein TEXT,                              -- IRS EIN if 501(c)(3)
  status TEXT NOT NULL,                  -- pending|verified|suspended
  tier TEXT NOT NULL,                    -- community_free|local_nonprofit|standard|premium|sponsor|district
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  address TEXT,
  irs_pub78_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE schools (
  id TEXT PRIMARY KEY,                   -- maps to Davis SD school id
  name TEXT NOT NULL,
  level TEXT NOT NULL,                   -- elementary|junior|high|special
  apptegy_site_id TEXT,
  active INTEGER DEFAULT 1
);

-- ─── Flyers ────────────────────────────────────────────────────────────────
CREATE TABLE flyers (
  id TEXT PRIMARY KEY,                   -- ulid
  org_id TEXT NOT NULL REFERENCES orgs(id),
  audience TEXT NOT NULL,                -- parents|employees   (the two tenants)
  title TEXT NOT NULL,
  title_es TEXT,
  body_html TEXT,
  body_html_es TEXT,
  raw_r2_key TEXT,                       -- original upload (evidence only)
  rendered_r2_key TEXT,                  -- canonical accessible HTML, EN
  rendered_r2_key_es TEXT,
  category TEXT,
  event_starts_at INTEGER,
  event_ends_at INTEGER,
  event_location TEXT,
  cta_label TEXT,
  cta_url TEXT,
  status TEXT NOT NULL,                  -- draft|pending_payment|submitted|ai_review|reviewer|approved|rejected|scheduled|sent|archived
  ai_verdict_json TEXT,                  -- moderation, WCAG, dedup, confidence
  reviewer_id TEXT,
  reviewer_decision TEXT,                -- approve|reject|request_changes
  reviewer_decision_at INTEGER,
  reviewer_reason TEXT,
  scheduled_send_at INTEGER,
  embedding_vector_id TEXT,
  prompt_version TEXT,                   -- which prompts.ts version generated this
  submitted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_flyers_status ON flyers(status, scheduled_send_at);
CREATE INDEX idx_flyers_org ON flyers(org_id, submitted_at DESC);
CREATE INDEX idx_flyers_pending ON flyers(submitted_at) WHERE status IN ('submitted','ai_review','reviewer');
CREATE INDEX idx_flyers_approved ON flyers(event_starts_at, event_ends_at) WHERE status='approved';

CREATE TABLE flyer_schools (
  flyer_id TEXT NOT NULL REFERENCES flyers(id),
  school_id TEXT NOT NULL REFERENCES schools(id),
  PRIMARY KEY (flyer_id, school_id)
);

-- ─── People (parents AND employees as one model with audience flag) ────────
CREATE TABLE subscribers (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL,                -- parent|employee
  email TEXT UNIQUE NOT NULL,
  email_verified_at INTEGER,
  phone TEXT,                            -- E.164
  phone_verified_at INTEGER,
  language TEXT DEFAULT 'en',            -- en|es
  quiet_start INTEGER DEFAULT 20,
  quiet_end INTEGER DEFAULT 8,
  weekly_cap INTEGER DEFAULT 2,
  emergency_lane_optin INTEGER DEFAULT 0,
  unsubscribed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_subscribers_audience ON subscribers(audience, unsubscribed_at);

CREATE TABLE subscriber_schools (
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  school_id TEXT NOT NULL REFERENCES schools(id),
  grade INTEGER,
  child_color TEXT,                      -- Cozi-style
  PRIMARY KEY (subscriber_id, school_id, grade)
);

CREATE TABLE subscriber_topics (
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  topic TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, topic)
);

-- ─── Consent (TCPA evidence) ───────────────────────────────────────────────
CREATE TABLE consent_log (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES subscribers(id),
  channel TEXT NOT NULL,                 -- email|sms|emergency
  action TEXT NOT NULL,                  -- optin|optout|preference_change|verify
  language_version TEXT NOT NULL,        -- exact policy version they agreed to
  source_url TEXT,
  ip TEXT,
  user_agent TEXT,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX idx_consent_subscriber ON consent_log(subscriber_id, recorded_at DESC);

CREATE TABLE suppressions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,                 -- email|sms
  identifier TEXT NOT NULL,              -- email lowercase OR phone E.164
  reason TEXT,                           -- stop|bounce|complaint|manual
  recorded_at INTEGER NOT NULL,
  UNIQUE(channel, identifier)
);

-- ─── Delivery ──────────────────────────────────────────────────────────────
CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  flyer_id TEXT REFERENCES flyers(id),
  subscriber_id TEXT REFERENCES subscribers(id),
  provider TEXT,                         -- postmark|ses
  provider_message_id TEXT,
  status TEXT,                           -- queued|sent|delivered|opened|clicked|bounced|complaint
  sent_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX idx_email_log_flyer ON email_log(flyer_id);
CREATE INDEX idx_email_log_subscriber ON email_log(subscriber_id, sent_at DESC);

CREATE TABLE sms_log (
  id TEXT PRIMARY KEY,
  flyer_id TEXT REFERENCES flyers(id),
  subscriber_id TEXT REFERENCES subscribers(id),
  provider TEXT,                         -- twilio|telnyx
  provider_message_id TEXT,
  segments INTEGER,
  status TEXT,
  sent_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE delivery_events (           -- public-facing analytics
  id TEXT PRIMARY KEY,
  flyer_id TEXT REFERENCES flyers(id),
  subscriber_id TEXT REFERENCES subscribers(id),
  event TEXT NOT NULL,                   -- view|click|rsvp|calendar_add|share
  metadata_json TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_delivery_flyer ON delivery_events(flyer_id, occurred_at);

-- ─── Approvals & audit ─────────────────────────────────────────────────────
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  flyer_id TEXT NOT NULL REFERENCES flyers(id),
  reviewer_id TEXT,
  decision TEXT,                         -- approve|reject|request_changes
  reason TEXT,
  ai_overridden INTEGER DEFAULT 0,
  decided_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,                         -- staff entra oid
  actor_role TEXT,
  action TEXT NOT NULL,                  -- read_subscriber|export|approve_flyer|...
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, occurred_at DESC);

-- ─── Payments ──────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  flyer_id TEXT REFERENCES flyers(id),
  org_id TEXT REFERENCES orgs(id),
  stripe_payment_intent TEXT,
  amount_cents INTEGER,
  currency TEXT DEFAULT 'usd',
  status TEXT,                           -- requires_payment|succeeded|refunded|failed
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ─── Sponsors ──────────────────────────────────────────────────────────────
CREATE TABLE sponsors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL,                    -- friend|partner|patron|champion
  annual_amount_cents INTEGER,
  attribution_text TEXT,
  active_from INTEGER,
  active_until INTEGER
);

-- ─── Magic links & sessions ────────────────────────────────────────────────
CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,                 -- submitter_login|parent_optin|verify_email
  hashed_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_magic_email ON magic_link_tokens(email, expires_at);

-- ─── Short links ───────────────────────────────────────────────────────────
CREATE TABLE sms_short_links (
  slug TEXT PRIMARY KEY,                 -- 5–6 chars in go.daviskids.org/<slug>
  long_url TEXT NOT NULL,
  flyer_id TEXT REFERENCES flyers(id),
  click_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
```

**Indexing notes:** partial indexes are intentional — D1 supports them and they keep the hot paths cheap. `idx_flyers_pending` covers the reviewer queue; `idx_flyers_approved` covers the public board. `delivery_events` will be the largest table; archive quarterly to R2 to stay under the D1 10 GB cap.

---

## 7. AI pipeline

**Provider abstraction lives in `src/server/ai/client.ts`.** Default provider is Anthropic. Cloudflare Workers AI is the secondary. Switching is a config change, not a refactor.

| Task | Default model | Why |
|---|---|---|
| OCR + structured extraction (vision) | `claude-sonnet-4-6` | Best vision reasoning over messy PDFs |
| Alt-text per region (vision) | `claude-sonnet-4-6` | Same call as extraction; saves tokens |
| Image-of-text detection | `claude-sonnet-4-6` | Returns `{is_image_of_text, extracted_text}` so we can rebuild HTML |
| WCAG contrast (math, no AI) | `src/server/ai/contrast.ts` | Sample foreground/background, run luminance formula |
| Content moderation | `claude-haiku-4-5` | Cheap, fast, good enough for policy classification |
| EN→ES translation | `claude-haiku-4-5` | Latin American neutral, preserves dates as "viernes 15 de mayo" |
| SMS condense (130 char) | `claude-haiku-4-5` | Phase 2 |
| Categorization | `claude-haiku-4-5` | Tag classification, deterministic |
| Embedding (dedup) | `@cf/baai/bge-base-en-v1.5` | **768-dim, matches existing skippy-memory index** |
| Search rerank | `@cf/baai/bge-reranker-base` | Pairs with Vectorize for parent search (Phase 3) |

**Critical:** the AI pipeline runs **only inside the `def-ai-pipeline` Queue Consumer**, never inline in the upload Worker. The HTTP Worker that handles `POST /api/submit` writes a row, enqueues a job, returns immediately. The Consumer has the 15-minute CPU budget; the HTTP Worker has 30 seconds.

**Prompt versioning:** `src/server/ai/prompts.ts` exports versioned prompt strings. Every change bumps the `PROMPT_VERSION` constant. Every flyer row stores the version that generated it, so we can replay against old versions for debugging.

**Cost target:** ~$0.03–0.08 per flyer through the full pipeline with prompt caching on system prompts. Batch API where applicable. Budget: $100/mo at 1,000 flyers/mo.

---

## 8. Authentication

| Surface | Mechanism |
|---|---|
| Staff (admin, reviewer) | **Microsoft Entra ID via OIDC auth-code-with-PKCE.** Bateman provisions the app registration. Group claims drive role assignment (DEF Reviewer, DEF Admin). |
| Submitter (community org, vendor) | **Magic link** — 15-min expiry, hashed in D1, single-use, rate-limited per email per hour. |
| Parent | Magic link (email) for opt-in and prefs. **Twilio Verify phone OTP** as fallback in Phase 2. |
| API → API | Workers secrets, never in chat or repo. |

Sessions: HttpOnly Secure SameSite=Lax cookies, signed with a Workers secret HS256 key. Dual-key rotation strategy.

**No passwords anywhere.** No social login. No SSO except Entra for staff.

---

## 9. Email & SMS providers

**Email (Phase 1 launch):**
- **Postmark** for transactional (magic links, receipts, vendor approval notices, employee notifications) — $15/mo Basic
- **AWS SES** for bulk parent digests — $0.10/1K, plus $24.95/mo dedicated IP once sustained sending crosses ~250K/mo
- SPF, DKIM, DMARC required from Day 1. `mail.daviskids.org` subdomain.
- **Cloudflare Email Service** is in beta — defer adoption. **Do not use MailChannels** — discontinued for free Workers in 2024.
- **Do not use Resend for bulk.** It was in earlier drafts; SES has better economics above 250K/mo. Postmark + SES is the answer.

**SMS (Phase 2, after 10DLC APPROVED):**
- **Twilio Charity 501(c)(3) campaign** — $4.50 brand + $15 campaign vetting + $3/mo recurring + per-segment fees
- T-Mobile per-segment carrier-fee waiver applies automatically once Charity status is verified
- ~75 MPS on AT&T → 50K-recipient broadcast in ~11 min
- **Telnyx is the abstraction-layer fallback.** If Twilio costs/availability shift, the SMS client wrapper makes switching a config change.
- Branded short links at `go.daviskids.org/<slug>` only. Generic shorteners are carrier-flagged.
- MMS deferred indefinitely — 3–4× cost, transcoding/accessibility problems.

---

## 10. Rate card (rough — needs Sherry/Kara sign-off in Phase 0)

Codex was clear: don't ship pricing without internal sign-off. This is the proposal, not the final table.

| Tier | Eligibility | Per-school | District-wide | Annual unlimited |
|---|---|---|---|---|
| **Community Free** | 501(c)(3), local, ≤1 flyer/month, no fundraising | $0 | $0 | — |
| **Local Nonprofit** | Verified 501(c)(3), youth-focused | $15 | $300 | $1,500/yr (5/mo cap) |
| **Standard** | For-profit programs, camps, tutoring | $25 | $750 | $4,500/yr |
| **Premium** | Logo placement + targeting + analytics | $50 | $1,250 | Custom |
| **DSD Ads (employee channel)** | Vendor → ~8K employees | — | $150 base | Bundle with parent districtwide for $1,500 |

**Sponsor program (annual recurring):**
- Champion $25K · Patron $10K · Partner $5K · Friend $1,500
- 6 slots/year × $7,500 avg = $45K recurring before per-flyer revenue

**Add-on revenue (Phase 2+):**
- SMS amplification +$250 districtwide
- Priority placement +$100
- Schedule boost (peak window) +$50
- AI-translated Spanish — free, marketed as differentiator

**The Peachjar comparison anchor:** $25 × 92 schools = $2,300 for one district-wide flyer on Peachjar today. DEF Flyers's Local Nonprofit tier puts the same reach at $300. That's the headline.

**Stripe rule:** flyer revenue runs through a **separate Stripe account** at standard 2.9% + $0.30. DEF's existing donation account stays untouched to preserve the 2.2% nonprofit rate (which only applies if >80% of volume is tax-deductible donations).

---

## 11. Risk register

From Codex's review, plus a few additions:

1. **Treating the April 2027 IFR extension as license to delay.** It is not. Section 504 and private litigation apply now. **Build to WCAG 2.1 AA at launch.**
2. **Submitters uploading image-only PDFs.** Reject at submission. Force structured fields. AI extracts and rebuilds HTML when an image is supplied.
3. **Stripe nonprofit-discount disqualification** if flyer revenue mixes with donations. Separate account is mandatory.
4. **Twilio campaign vetting delay.** Submit on Day 1 of Phase 1. Do not promise SMS launch dates that depend on the campaign before it shows APPROVED.
5. **Utah raffle law.** Sweepstakes only, AMOE published, never the word "raffle."
6. **PII / FERPA on parent rosters.** Encrypt at rest (D1 default), audit-log every staff read of subscriber data, role-gate via Entra groups.
7. **MailChannels is dead.** Postmark + SES from Day 1.
8. **Worker CPU limit on inline AI calls.** Never call Claude vision in a fetch handler. Always Queue Consumer.
9. **D1 has no cross-DB JOINs.** Single DB, archive event logs to R2.
10. **Generic short-link domains get carrier-filtered.** `go.daviskids.org` only.
11. **Peachjar vendor lock-in clause.** Until current Peachjar agreement expires, DEF (not DSD) is the contracting party with parents. Every parent surface reads "from DEF, in partnership with DSD."
12. **Vectorize indexing delay.** 60–90 seconds after upsert before vectors are queryable. Don't treat empty results as failure immediately.
13. **TV/podcast audio noise** (carryover Skippy lesson — non-issue here, but a reminder that classification layers matter).
14. **Two Codex sessions on the same repo simultaneously.** Standing rule. Don't.
15. **AI confidence theatre.** AI's "confidence" score is not a license to skip review. Phase 1 = 100% human review. Auto-publish only after we have local evidence.

---

## 12. Day 1 of Phase 1 — concrete tasks

**Pre-condition:** Phase 0 checklist closed.

```
Hour 1–2 — repo + infra
[ ] git clone the new ramonscottf/def-flyers repo (Scott creates it, sets PAT)
[ ] wrangler login + verify account 77f3d6611f5ceab7651744268d434342
[ ] wrangler d1 create def-flyers-db
[ ] wrangler r2 bucket create def-flyers-flyers-raw
[ ] wrangler r2 bucket create def-flyers-flyers-html
[ ] wrangler r2 bucket create def-flyers-archive
[ ] wrangler kv namespace create def-flyers-sessions
[ ] wrangler kv namespace create def-flyers-rate
[ ] wrangler kv namespace create def-flyers-shortlinks
[ ] wrangler queues create def-ai-pipeline
[ ] wrangler queues create def-email-batch
[ ] wrangler queues create def-webhook-events
[ ] wrangler queues create def-flyer-dlq
[ ] Confirm skippy-memory dimension is 768 (Scott's memories say yes; verify before first embed)

Hour 3–4 — DNS + email auth
[ ] flyers.daviskids.org A record → CF
[ ] go.daviskids.org A record → CF
[ ] mail.daviskids.org SPF + DKIM + DMARC (Postmark + SES dual-vendor)
[ ] Postmark server "def-flyers-transactional" created, daviskids.org domain verified
[ ] AWS SES sending identity for daviskids.org, request production access (out of sandbox — takes 24h)
[ ] wrangler secret put POSTMARK_API_KEY
[ ] wrangler secret put AWS_SES_KEY / AWS_SES_SECRET
[ ] wrangler secret put ANTHROPIC_API_KEY
[ ] wrangler secret put STRIPE_SECRET_KEY (separate flyer-revenue account, test mode)

Hour 5–6 — Astro + Hono skeleton
[ ] npm create astro, @astrojs/cloudflare adapter, Tailwind
[ ] Three skeleton pages: /, /submit, /flyer/[id]
[ ] Hono Worker with three routes: POST /api/submit, GET /api/flyer/:id, POST /api/parent/optin
[ ] Push to main, verify Pages auto-deploys to flyers.daviskids.org
[ ] Drizzle config + first migration (0001_init.sql) applied to D1

Hour 7–9 — AI pipeline scaffold
[ ] src/server/ai/client.ts (provider abstraction, Anthropic default)
[ ] extract.ts, render.ts, translate.ts, embed.ts as separate functions
[ ] src/server/queues/aiPipeline.ts consumer wires them together
[ ] curl POST /api/submit with a sample flyer PDF
[ ] Verify Consumer picks up, runs the chain, writes accessible HTML to R2, persists to D1, upserts to Vectorize

Hour 10–12 — reviewer queue + first end-to-end
[ ] /admin/index.astro with Entra ID stub auth (toggle to real Entra when Bateman delivers)
[ ] AI verdict surface: WCAG check, moderation flags, dedup result, suggested category, confidence
[ ] Approve/reject buttons → enqueue to def-email-batch
[ ] Consumer fans out via Postmark with FlyerDigest React Email template
[ ] Send to a single test parent email
[ ] Verify deliverability in Gmail and Outlook (both Hale family Microsoft license and personal Gmail)

Hour 13 — landing pages
[ ] Replace daviskids.org/advertise-peachjar.html with "Coming soon — submit at flyers.daviskids.org"
[ ] Replace daviskids.org/advertise-dsd-ads.html similarly
[ ] CSS-only edits to def-site repo, never sed on HTML (standing rule)
```

**End of Day 1:** a single flyer can be submitted by curl, processed end-to-end through the AI pipeline, manually approved, and delivered as a WCAG-AA HTML email to a parent. That is the entire product loop. Everything after that is volume, polish, and SMS.

---

## 13. CI gates

Every PR must pass:
1. `tsc --noEmit` (typecheck)
2. `drizzle-kit check` (no schema drift)
3. `vitest run` (unit tests, including consent.spec.ts, tcpa.spec.ts)
4. **`axe-core` against rendered flyer HTML** (zero AA violations on the published render)
5. Build succeeds for both Astro and Worker

Nightly on staging:
- Playwright + axe-core against `/board`, `/flyer/[id]`, `/submit`, `/parent`, `/admin`
- Synthetic flyer submission end-to-end

---

## 14. Open questions for Scott to resolve in Phase 0

1. **Sender of record.** DEF or DSD? (Recommendation: DEF, because of Peachjar's vendor lock-in.)
2. **Peachjar termination clause** — when can DEF exit cleanly?
3. **Current dsdads sender platform** — district mail server? Constant Contact? Mailchimp? M365 distribution group?
4. **Karah Crosby + Sherry Miggin sign-off on rate card** (§10).
5. **Bateman's timeline for Entra app registration.** Critical-path for Phase 1 admin auth.
6. **District communications office contact** (the current "Admin. Asst./Peachjar" role) — preview the new approval workflow with them so they don't perceive DEF as taking authority.
7. **Davis SD board policy on "distribution of materials."** Likely indexed only inside the policy-manual PDF tree. Scott pulls.
8. **DEF brand book / `/about-brand.html` source from def-site repo.** Pull color hex, logo, typography into `public/styles.css`.
9. **Twilio account** (SID in Scott's memories, redacted from public docs) — confirm brand registration status and any prior campaign attempts before submitting fresh.
10. **Existing donation Stripe account** — confirm current pricing tier (standard or 2.2% nonprofit) before opening the second account.

---

## 15. What we are explicitly NOT building

This list is as important as what we are building. Codex was emphatic.

- ❌ Auto-publish / green-lane (Phase 1)
- ❌ Two-way chat / parent ↔ org messaging
- ❌ MMS
- ❌ Sponsor self-service portal (admin-managed only at launch)
- ❌ Per-child color-coded calendar (Phase 4)
- ❌ Apptegy iframe embeds (Phase 3)
- ❌ Multi-language beyond Spanish (Phase 4 if ever)
- ❌ ICS feed (Phase 3)
- ❌ ClassDojo-style chat
- ❌ Anything that pulls from SIS without a signed DPA
- ❌ Resend for bulk email
- ❌ MailChannels (deprecated)
- ❌ Generic short-link domains
- ❌ The word "raffle"

---

## 16. Skippy operating rules baked into this build

For Codex's reference:

- **Build, don't explain.** Ship the file, don't paste commands.
- **Cloudflare auth:** `X-Auth-Key` + `X-Auth-Email` (Global API Key). Never Bearer.
- **Pages deploys are atomic** — fetch all existing files before redeploy or everything else gets wiped.
- **D1 batch inserts:** Python urllib with JSON serialization, not bash heredoc.
- **CSS changes on live sites:** appended to stylesheet only. Never sed on HTML.
- **Wrangler KV writes from CLI don't always surface at the Worker edge.** Use a POST endpoint on the Worker for reliable KV writes.
- **Vectorize indexing delay** is 60–90s. Don't treat empty results as failure immediately.
- **Workers vs Pages:** for full control over routing with D1/R2, prefer single Worker with custom domain. Pages is for the static UI shell.
- **Open-source first.** Always present free alternatives.
- **Credentials never in chat.** Rotate if exposed.
- **Mobile nav on hiresbigh is done.** Don't touch (unrelated repo, but the rule travels).

---

## 17. Conclusion

**The product:** one platform, two tenants (parents + employees), submit → AI-assist → human-approve → publish → notify → measure. Email-only at launch. SMS when 10DLC APPROVED. WCAG 2.1 AA from Day 1. HTML-first, PDF supplemental. EN + ES. DEF as contracting party with parents. Separate Stripe account.

**The strategic prize is not the flyer revenue.** It is the opted-in parent communication channel that DEF owns end-to-end — a 50,000-household double-opt-in list that doesn't exist today and that seeds every Parent Hub feature DEF will ship over the next three years.

**The research is done. The architecture is decided.** The only thing standing between today and a working flyer round-trip on Day 1 is closing the Phase 0 governance checklist.

Phase 0 starts now. Phase 1 starts the day Phase 0 closes.
