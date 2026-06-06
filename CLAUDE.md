# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@.claude/skippy/identity.md

---

# Project: DEF Flyers

Community flyer + DSD Ads platform for the **Davis Education Foundation** — replaces Peachjar
(parent flyers) and DSD Ads (employee blasts) with one Foundation-owned, accessible, opt-in
channel. A single Cloudflare Worker, live at **https://flyers.daviskids.org**.

**Authoritative docs:** `CODEX_BRIEF.md` is the operational "build this next" handoff (Phase 1
sequence, what NOT to rebuild, verification). `docs/HANDOFF.md` is the full strategy/architecture
rationale. Read those before large changes.

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit — the ONLY automated gate today; must pass before shipping
npm run dev              # wrangler dev (local)
npm run deploy           # wrangler deploy → flyers.daviskids.org
npm run tail             # live production logs
npm run db:migrate       # wrangler d1 migrations apply dsd-flyers --remote
npm run db:migrate:local # same, --local
npm run db:seed          # wrangler d1 execute dsd-flyers --remote --file=migrations/0002_seed.sql
```

There is **no test runner and no linter** — `tsc --noEmit` is the gate. Verification is by smoke
test against live endpoints (see `CODEX_BRIEF.md` §6) — e.g.
`curl -s https://flyers.daviskids.org/health`.

Cloudflare auth for direct API/Wrangler work (set in shell; **never Bearer**):
```bash
export CLOUDFLARE_EMAIL="ramonscottf@gmail.com"
export CLOUDFLARE_API_KEY="<global-api-key>"   # secret — not stored in repo
export CLOUDFLARE_ACCOUNT_ID="77f3d6611f5ceab7651744268d434342"
```
App secrets are set with `wrangler secret put` (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
`RESEND_WEBHOOK_SECRET`, later `AWS_SES_*`, `STRIPE_*`, `TWILIO_*`). Never commit secrets —
GitHub push protection will block them.

## Architecture

Cloudflare Worker, **Hono 4 + TypeScript**, server-rendered with **Hono JSX**
(`jsxImportSource: hono/jsx` — no React SPA, HTMX for admin action buttons). Entry is
`src/index.ts`, which mounts feature routers.

- **`src/routes/`** — the surface. `landing` (`/`), `public`/`publicPages`
  (`/api/public/{schools,departments,feed}`, board), `submitter`/`submitterFlyers` (+ their
  `*Pages.ts` views — the magic-link login + submission wizard, scoped to `/submit/*`),
  `parent` (opt-in/preferences/unsubscribe), `admin`/`adminPages` (reviewer queue at `/admin`),
  `webhooks` (Resend, Svix-signed — bounces/complaints).
- **`src/auth/`** — `magicLink.ts` (32-byte token, SHA-256 hashed at rest, 15-min TTL) and
  `session.ts` (`def_session` HttpOnly cookie, 30-day TTL, `requireSession` middleware). Submitter
  + parent auth is magic-link; staff auth is Microsoft Entra OIDC (future).
- **`src/ai/`** — the PDF/image → form **pre-fill pipeline** (runs inline via `ctx.waitUntil`):
  `pipeline.ts` orchestrates; `client.ts` is the provider abstraction (**Claude Sonnet 4.6** for
  vision/extraction + **Haiku 4.5** for translation/moderation, Workers AI as fallback);
  `extract.ts` (structured extraction + image-of-text detection); `prompts.ts` (every prompt is a
  const with a `PROMPT_VERSION` — bump on edit, stored per-flyer for replay); `contrast.ts` (WCAG
  luminance math via Browser Rendering, no AI).
- **`src/publish/`** — `render.ts` (accessible HTML, EN + ES) and `index.ts` (the publish step:
  render to R2 at `flyers/{slug}/index.html`, fan out to subscribers). Driven by the cron
  (`*/5 * * * *`) that sweeps `status='scheduled'` flyers past their `scheduled_send_at`.
- **`src/email/`** — Resend templates (`magicLink`, `parentVerify`, `reviewerNotice`,
  `flyerSingle`) sent through `src/lib/email.ts` (`EmailSender` interface — Resend now, SES for
  bulk parent digests in Phase 3+).
- **`src/lib/`** — `ulid`, `slug`, `readability` (Flesch-Kincaid reading level), `rateLimit` (KV).
- **`migrations/`** — D1 schema, additive only. `0001_init` (18 tables) + `0002_seed` (69 schools,
  10 departments), then `0003_ai_columns`, `0004_publishing`, `0005_consent_and_suppressions`,
  `0006_subscriptions_language`. **Never edit `0001_init.sql`** — always add a new migration.

Bindings (`wrangler.toml`): `DB` (D1 `dsd-flyers`), `ASSETS` (R2 `dsd-flyers-assets`), `KV`,
`AI` (Workers AI), `BROWSER` (Browser Rendering). Vectorize (`def-flyers-search`) is planned for
Phase 2 search; until then the shared `skippy-memory` index (768-dim, `bge-base-en-v1.5`) is the
embedder of record — **do not switch embedders.**

## Project conventions & guardrails

These come from Scott's standing rules (`CODEX_BRIEF.md` §3, README "Non-negotiables") — they are
enforceable, not stylistic:

- **AI assists, never decides.** 100% human review of flyers at launch — no auto-publish (Phase 3
  at earliest, and only after local data proves the AI verdict).
- **HTML-first, PDF supplemental** — structured fields before any upload.
- **Schema is additive** — new migration file, never edit `0001_init.sql`. Don't change the schema
  for Phase 1 unless required.
- **Don't switch the embedder** from `bge-base-en-v1.5` (768-dim) — must match `skippy-memory`.
- **WCAG 2.1 AA at launch** (Section 504); a11y score threshold is `A11Y_PASS_THRESHOLD=85`.
- **TCPA**: double opt-in, store the consent text version, honor STOP. **Don't store phone numbers
  / send SMS** (Phase 2, 10DLC not yet approved).
- **No `sed` on production HTML** — CSS-only, appended, reviewed. **No entrance animations on
  heroes** (no "Squarespace energy" — the PR will be rejected).
- **Email:** no MailChannels (discontinued); Resend is transactional Phase 1 only — bulk parent
  digests go to AWS SES in Phase 3+.
- **Stripe**: separate flyer-revenue account, never mixed with donation Stripe; not in Phase 1.
- **All `/api/*` responses** use a consistent error shape `{error: 'code', message?: '...'}`. Every
  admin action writes `admin_audit_log`; every flyer status change writes a `flyer_revisions`
  snapshot.
- **The old dormant `dsd-flyers` Worker** can be deleted; the `dsd-flyers` **D1 database must not**
  — this Worker reads from it.

## Phase state

Phase 0 (governance) is Scott-driven and ongoing. **Phase 1 (MVP)** — submitter portal, AI
pipeline, reviewer queue, email-only delivery, public board — is the current build. Phases 2 (SMS
+ prefs), 3 (replace Peachjar/DSD Ads, paid tiers), 4 (parent hub) are gated downstream. Don't
build ahead of the current phase; see the phase table in `README.md`.

## Skippy Capture

`.github/workflows/skippy-capture.yml` calls the org-level reusable workflow at
`ramonscottf/.github` on every push — it feeds commit activity into the Skippy Context Engine
(Phase 4.1.1). Don't remove it; it's part of the capture mandate, not project CI.
