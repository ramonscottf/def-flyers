# DEF Flyers

Community flyer + DSD Ads platform for the Davis Education Foundation.
Replaces Peachjar (parent flyers) and DSD Ads (employee blasts) with one Foundation-owned, accessible, opt-in channel.

**Live:** https://flyers.daviskids.org · **Repo:** https://github.com/ramonscottf/def-flyers
**Owner:** Scott Foster (ramonscottf@gmail.com)

---

## Status (April 29, 2026)

✅ **Scaffold deployed.** Worker live on `flyers.daviskids.org`. Schema + seed data preserved from prior `dsd-flyers` build (69 schools, 10 departments). Public endpoints returning 200.

🔨 **Phase 1 (MVP) work begins now.** See **[`CODEX_BRIEF.md`](./CODEX_BRIEF.md)** for the operational handoff — it's the authoritative "build this next" doc. The full strategy (synthesized from two long research plans + Codex's review) lives in **[`docs/HANDOFF.md`](./docs/HANDOFF.md)**.

---

## Live endpoints

| Path | Status | Notes |
|---|---|---|
| `GET /` | 200 | Accessible landing page, no JS, navy/red/gold |
| `GET /health` | 200 | `{ok, service, env, db, ts}` |
| `GET /api/public/schools` | 200 | All 69 Davis SD schools |
| `GET /api/public/departments` | 200 | All 10 DSD departments |
| `GET /api/public/feed` | 200 | Published flyers (empty until first publish) |
| `/api/submitter/*` | 501 | Phase 1 stubs |
| `/api/admin/*` | 501 | Phase 1 stubs |

## Stack

- **Runtime:** Cloudflare Workers + Hono 4
- **DB:** D1 (`dsd-flyers` — 18 tables, 69 schools + 10 departments seeded)
- **Storage:** R2 (`dsd-flyers-assets`) for original uploads and rendered HTML
- **Cache:** KV (`dsd-flyers-kv`) for sessions, rate limits, short links
- **AI:** Claude Sonnet 4.6 (vision/extraction) + Haiku 4.5 (translation/moderation/SMS)
- **Embeddings:** `@cf/baai/bge-base-en-v1.5` (768-dim, must match `skippy-memory`)
- **Email:** Postmark (transactional) + AWS SES (bulk)
- **SMS:** Twilio Charity 10DLC (Phase 2)
- **Payments:** Stripe (separate flyer-revenue account, Phase 3)
- **Staff auth:** Microsoft Entra ID (OIDC PKCE — Bateman provisions the app reg)
- **Submitter/parent auth:** Magic links via email

## Quick start

```bash
npm install
npm run typecheck
npm run dev              # local with wrangler
npm run deploy           # deploy to flyers.daviskids.org
npm run db:migrate       # apply schema (idempotent)
npm run db:seed          # apply seed data (idempotent — INSERT OR IGNORE)
```

Cloudflare auth (set in your shell):
```bash
export CLOUDFLARE_EMAIL="ramonscottf@gmail.com"
export CLOUDFLARE_API_KEY="<global-api-key>"   # from Scott's secrets
export CLOUDFLARE_ACCOUNT_ID="77f3d6611f5ceab7651744268d434342"
```

## Repo structure

```
def-flyers/
├── README.md
├── CODEX_BRIEF.md            # ← read this for next-step build instructions
├── docs/
│   └── HANDOFF.md            # full strategy + architecture rationale
├── wrangler.toml             # bindings, custom domain, observability
├── src/
│   ├── index.ts              # Hono entrypoint, health, landing, route mounts
│   └── routes/
│       ├── landing.ts        # public landing page
│       ├── public.ts         # /api/public/{schools,departments,feed}
│       ├── submitter.ts      # /api/submitter/* — Phase 1 stubs
│       └── admin.ts          # /api/admin/*    — Phase 1 stubs
├── migrations/
│   ├── 0001_init.sql         # full schema (18 tables)
│   └── 0002_seed.sql         # 69 schools + 10 departments
└── package.json
```

## Phase plan

| Phase | Scope | Trigger |
|---|---|---|
| **0** Governance | Peachjar review, DPA, sender-of-record, policies, rate-card sign-off, Twilio 10DLC submission, Entra request | Scott drives, in progress |
| **1** MVP | Submitter portal, AI pipeline, reviewer queue, email-only delivery, public flyer board | **Now** |
| **2** SMS + Prefs | Twilio Verify, double opt-in, preference center, emergency-only lane | After 10DLC APPROVED |
| **3** Replace Peachjar + DSD Ads | Tiered pricing live, DSD Ads tenant, submitter analytics | After Phase 2 stable |
| **4** Parent Hub | Emergency alerts, event reminders, volunteer signups | 90+ days post-launch |

## Non-negotiables

1. **AI assists, does not decide** — every flyer gets human review at launch
2. **HTML-first, PDF supplemental** — structured fields *before* upload
3. **Separate Stripe account** for flyer revenue (don't mix with donation Stripe)
4. **Twilio 10DLC submitted Day 1** — SMS doesn't exist until APPROVED
5. **DEF is the contracting party with parents, not DSD** (Peachjar lock-in clause)
6. **WCAG 2.1 AA at launch** — Section 504 applies now
7. **TCPA full PEWC, double opt-in, STOP within 10 business days**
8. **No `sed` on production HTML** — CSS-only, reviewed
9. **No two agents pushing this repo simultaneously**
10. **No entrance animations on heroes** (Skippy rule — no Squarespace energy)

See `CODEX_BRIEF.md` for the full Phase 1 build sequence.

## Cloudflare resources

| Resource | Name | ID |
|---|---|---|
| D1 (production) | `dsd-flyers` | `5b5de1d1-ca4a-4e27-bad5-f0a071a75b58` |
| D1 (dev) | `dsd-flyers-dev` | `2c95fbe9-ed47-4099-8b39-d7bbc6a873a5` |
| R2 | `dsd-flyers-assets` | — |
| KV | `dsd-flyers-kv` | `72249a65614a42f987b766e8ee616f68` |
| Vectorize | `skippy-memory` (shared, 768-dim, bge-base-en-v1.5) | — |
| Zone | daviskids.org | `e9aac6e9fab72eae9eda35335bc47f40` |
| Account | Scott | `77f3d6611f5ceab7651744268d434342` |
