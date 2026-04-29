# DEF Flyers

Community flyer + DSD Ads platform for the Davis Education Foundation.
Replaces Peachjar (parent flyers) and DSD Ads (employee blasts) with one Foundation-owned, accessible, opt-in channel.

**Live:** https://flyers.daviskids.org
**Repo:** https://github.com/ramonscottf/def-flyers
**Owner:** Scott Foster (ramonscottf@gmail.com)

---

## Stack

- **Runtime:** Cloudflare Workers + Hono
- **DB:** D1 (`dsd-flyers` — 69 schools, 10 departments seeded)
- **Storage:** R2 (`dsd-flyers-assets`) for original uploads and rendered HTML
- **Cache:** KV (`dsd-flyers-kv`) for sessions, rate limits, short links
- **AI:** Claude Sonnet 4.6 (vision/extraction) + Haiku 4.5 (translation/moderation/SMS)
- **Embeddings:** `@cf/baai/bge-base-en-v1.5` (768-dim)
- **Email:** Postmark (transactional) + AWS SES (bulk)
- **SMS:** Twilio Charity 10DLC (Phase 2)
- **Payments:** Stripe (separate flyer-revenue account, standard 2.9%+30¢)
- **Staff auth:** Microsoft Entra ID (OIDC PKCE, Bateman provisions)
- **Submitter/parent auth:** Magic links via email

## Quick start

```bash
npm install
npm run db:migrate       # apply schema (idempotent — schema already exists)
npm run db:seed          # apply seed data (also idempotent — INSERT OR IGNORE)
npm run dev              # local dev w/ wrangler
npm run deploy           # deploy to flyers.daviskids.org
```

## Repo structure

```
def-flyers/
├── wrangler.toml             # bindings, custom domain, observability
├── src/
│   ├── index.ts              # Hono entrypoint, health, landing
│   └── routes/
│       ├── landing.ts        # public landing page (no JS, accessible)
│       ├── public.ts         # /api/public/{schools,departments,feed}
│       ├── submitter.ts      # /api/submitter/* (Phase 1)
│       └── admin.ts          # /api/admin/*    (Phase 1)
├── migrations/
│   ├── 0001_init.sql         # full schema (18 tables) — preserved from Apr 27 build
│   └── 0002_seed.sql         # 69 schools + 10 departments, INSERT OR IGNORE
└── docs/
    └── HANDOFF.md            # synthesized build plan
```

## Phases

- **Phase 0 — Governance** (Scott drives, in progress): Peachjar contract review, DPA, sender-of-record, policies, Twilio 10DLC submission, Entra request to Bateman, rate-card sign-off
- **Phase 1 — MVP** (4–6 weeks): submitter portal, AI pipeline, reviewer queue, email-only delivery, public flyer board, axe-core CI gate
- **Phase 2 — SMS + Prefs** (after 10DLC APPROVED): Twilio Verify, double opt-in, preference center, emergency-only lane, sponsor attribution
- **Phase 3 — Replace Peachjar + DSD Ads**: rate-card-priced tiers live, DSD Ads tenant active, submitter analytics
- **Phase 4 — Parent Hub** (90+ days post-launch): emergency alerts, event reminders, volunteer signups

## Non-negotiables (read these first)

1. **AI assists, does not decide.** Every flyer gets human review at launch.
2. **HTML-first, PDF supplemental.** Structured fields *before* upload.
3. **Separate Stripe account for flyer revenue.** Don't mix with donation Stripe.
4. **Twilio 10DLC submission Day 1.** SMS does not exist until APPROVED.
5. **DEF is the contracting party with parents, not DSD.** Peachjar lock-in clause binds the district, not the Foundation.
6. **WCAG 2.1 AA at launch.** Section 504 applies now, IFR extension or not.
7. **TCPA full PEWC, double opt-in, STOP within 10 business days.**
8. **No `sed` on production HTML.** CSS-only edits, reviewed before deploy.
9. **No two agents pushing this repo simultaneously.**
10. **No entrance animations on heroes.** Skippy rule — no Squarespace energy.

See `docs/HANDOFF.md` for the full build plan.

## Cloudflare resources (shared with old `dsd-flyers` Worker)

| Resource | Name | ID |
|---|---|---|
| D1 | `dsd-flyers` | `5b5de1d1-ca4a-4e27-bad5-f0a071a75b58` |
| D1 (dev) | `dsd-flyers-dev` | `2c95fbe9-ed47-4099-8b39-d7bbc6a873a5` |
| R2 | `dsd-flyers-assets` | — |
| KV | `dsd-flyers-kv` | `72249a65614a42f987b766e8ee616f68` |
| Vectorize | `skippy-memory` (768-dim, bge-base-en-v1.5) | shared |
| Zone | daviskids.org | `e9aac6e9fab72eae9eda35335bc47f40` |
| Account | Scott | `77f3d6611f5ceab7651744268d434342` |

## Deprecation note

The old `dsd-flyers` Worker (deployed Apr 27, 2026) has no custom domain attached and remains in the account as fallback. Once `def-flyers` is verified live on `flyers.daviskids.org`, the old Worker will be deleted.
