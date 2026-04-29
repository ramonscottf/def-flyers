# CODEX_BRIEF.md — Phase 1 work session

**Read this first.** The full strategy lives in `docs/HANDOFF.md`. This doc is the operational handoff: where things stand right this minute, what to build next, what's already there, what NOT to touch, and how to verify each piece works.

**As of:** April 29, 2026 — initial scaffold deployed by Skippy (Claude Opus 4.7).
**Live:** https://flyers.daviskids.org · `def-flyers` Worker · 200s on all endpoints.
**Branch:** `codex/phase-1-handoff` (this PR). Merge when ready, then start work on `main` or new feature branches per task.

---

## 1. What is already done — DO NOT REBUILD

### Infra (Cloudflare account `77f3d6611f5ceab7651744268d434342`)
- ✅ Worker `def-flyers` deployed at `flyers.daviskids.org` (custom domain, HTTPS, CSP, NEL)
- ✅ D1 binding `DB` → `dsd-flyers` (id `5b5de1d1-ca4a-4e27-bad5-f0a071a75b58`)
  - 18-table schema applied
  - 69 schools and 10 departments seeded
- ✅ R2 binding `ASSETS` → `dsd-flyers-assets`
- ✅ KV binding `KV` → `72249a65614a42f987b766e8ee616f68`
- ✅ AI binding `AI` (Workers AI)
- ✅ Browser binding `BROWSER` (Browser Rendering)
- ✅ Observability + invocation logs enabled

### Code
- ✅ Hono + TypeScript scaffold, typecheck clean
- ✅ Landing page at `/` (no JS, accessible, navy/red/gold per Skippy memory rule)
- ✅ Working public endpoints:
  - `GET /health` → `{ok, service, env, db, ts}`
  - `GET /api/public/schools` → all 69 schools, ordered district→high→junior→elementary
  - `GET /api/public/departments` → all 10 departments
  - `GET /api/public/feed?school=&audience=&category=&limit=` → published flyers (empty for now)
- ✅ Stub routes returning 501 with phase notes:
  - `/api/submitter/*` (magic-link, submit, upload-url, finalize)
  - `/api/admin/*` (queue, approve, reject, request-changes, metrics, audit)

### Old infrastructure status
- The earlier `dsd-flyers` Worker (Apr 27 build) is **still in the account but has no domain attached.** It's safe but dormant. **Delete it via API once you've confirmed `def-flyers` is stable for ≥48h.** Do not delete the D1 — `def-flyers` reads from it.

### Schema highlights you'll be filling in
The schema in `migrations/0001_init.sql` already covers:
- `users`, `magic_links`, `sessions` (auth)
- `schools`, `departments`, `school_admins`, `department_admins` (org structure + admin scoping)
- `flyers`, `flyer_schools`, `flyer_departments`, `flyer_revisions` (content + version history)
- `accessibility_audits` (a11y findings per version)
- `subscriptions`, `deliveries`, `contact_imports` (parent/employee opt-in + delivery log)
- `analytics_events`, `admin_audit_log`

**You should NOT need to change the schema for Phase 1.** If you do, write a new migration `0003_*.sql`, never edit `0001_init.sql`.

---

## 2. What you are building — Phase 1 MVP

The end-to-end loop, **email-only at launch**:

```
submitter logs in via magic link
  → fills structured fields (title, summary, audience, scope, category, schools, dates, location, body, optional CTA)
  → optionally uploads supplemental PDF/image to R2 via presigned URL
  → clicks "submit for review"
  → AI pipeline runs (extract structured data if PDF, alt-text, EN→ES translate, moderation, a11y check)
  → flyer lands in admin reviewer queue with verdict
  → reviewer approves / rejects / requests changes
  → on approve: schedule send, render to R2 as accessible HTML, fan out to subscribers via Resend (Phase 1) / SES (Phase 3+)
  → public flyer board shows it; subscribers receive digest
```

### Priority order (build in this sequence)

#### 2.1 — Submitter auth (magic links)  *— start here*
**File:** `src/routes/submitter.ts`, plus a new `src/auth/magicLink.ts` and `src/lib/email.ts`.

- `POST /api/submitter/magic-link` body `{email}`
  - Validate email format
  - Rate limit: 3 requests / hour / email via KV (`ratelimit:magic:{email}`)
  - Generate 32-byte token, hash with SHA-256, store hash in `magic_links` table (token plaintext is what goes in the email)
  - Email magic link via Resend — link format: `https://flyers.daviskids.org/submit/verify?token=<plaintext>`
  - TTL 15 minutes (env var `MAGIC_LINK_TTL_MINUTES`)
  - Return `{ok: true}` regardless of whether the email is in the user table (no enumeration leak)

- `POST /api/submitter/verify` body `{token}`
  - Hash incoming token, look up by hash, reject if expired or already used
  - Mark `used_at`, find or create row in `users` (set `is_employee` based on `EMPLOYEE_EMAIL_DOMAIN` env var)
  - Create row in `sessions` with 30-day TTL (env var `SESSION_TTL_DAYS`)
  - Set HttpOnly Secure SameSite=Lax cookie `def_session=<session_id>`
  - Return `{user: {id, email, display_name, is_employee, is_district_admin}}`

- Add a `requireSession` Hono middleware to gate everything below.

**Email skeleton — Resend for Phase 1, abstract via interface:**
```ts
// src/lib/email.ts
export interface EmailSender {
  send(opts: { to: string; subject: string; html: string; text?: string; tag?: string }): Promise<{id: string}>;
}
// implement ResendSender first; swap in SES for bulk parent digests in Phase 3+
```
Resend "From": `flyers@daviskids.org`. Reply-To: `info@daviskids.org`. Use the REST API at `https://api.resend.com/emails` (no SDK needed in a Worker).

#### 2.2 — Submission flow
- `POST /api/submitter/submit` (auth required) — create `flyers` row with `status='draft'`
  - Required fields: `title`, `summary`, `audience` (parents|employees|both), `scope` (school|department|district), `category`, `expires_at`, target schools or departments
  - Optional: `body_html`, `body_plain`, event fields, image_alt_text, CTA
  - Generate slug from title + ulid suffix (`my-flyer-title-01jvk...`)
  - Compute `reading_level` and `word_count` from `body_plain` (Flesch-Kincaid; helper in `src/lib/readability.ts`)
  - Return `{flyer_id, slug, status}`

- `POST /api/submitter/submit/upload-url` body `{flyer_id, kind: 'pdf'|'image', content_type, size}`
  - Verify the submitter owns the flyer
  - Reject content-types not in `['application/pdf','image/jpeg','image/png','image/webp']`
  - Reject size > 10 MB
  - Generate R2 key: `flyers/{flyer_id}/{kind}-{ulid}.{ext}`
  - Return a presigned PUT URL (use `aws4fetch` or Workers' R2 binding `createPresignedUrl` if available; otherwise use the standard S3-compatible signed URL pattern with the R2 access key)
  - On successful upload, submitter calls `PATCH /api/submitter/flyer/:id` to set `pdf_r2_key` or `image_r2_key`

- `POST /api/submitter/flyer/:id/finalize`
  - Set `status='submitted'`, `submitted_at=now`
  - Insert into `flyer_revisions` (snapshot)
  - Enqueue AI pipeline job (next section)
  - Return `{status: 'submitted', estimated_review_time_hours: 24}`

#### 2.3 — AI pipeline
**File:** `src/ai/client.ts` (provider abstraction), `src/ai/pipeline.ts`, `src/ai/prompts.ts`.

For Phase 1, **run inline in the Worker via `ctx.waitUntil`** — Cloudflare Queues add complexity we don't need yet for a low-volume MVP. Migrate to Queues in Phase 2 if volume warrants.

The pipeline tasks, in order:
1. **Image-of-text detection + structured extraction** (Sonnet 4.6 vision) — only if a PDF/image was uploaded. Returns `{extracted_text, event_data, has_image_of_text}`. If `has_image_of_text=true`, write the extracted text into `body_plain` and rebuild `body_html` as semantic HTML.
2. **Alt-text generation** (Sonnet 4.6 vision) for the cover image, if any. Store in `image_alt_text`.
3. **EN→ES translation** (Haiku 4.5) for `title` and `body_html`. Store in new columns... wait — current schema doesn't have `title_es` / `body_html_es`. **Use migration `0003_es_columns.sql`:**
   ```sql
   ALTER TABLE flyers ADD COLUMN title_es TEXT;
   ALTER TABLE flyers ADD COLUMN body_html_es TEXT;
   ALTER TABLE flyers ADD COLUMN summary_es TEXT;
   ```
4. **Moderation** (Haiku 4.5) — return `{verdict: 'green'|'yellow'|'red', flags: [...], reasons: [...]}`. Store in a new column or in JSON within an existing one — see migration:
   ```sql
   ALTER TABLE flyers ADD COLUMN ai_verdict_json TEXT;
   ALTER TABLE flyers ADD COLUMN prompt_version TEXT;
   ```
5. **A11y math** (no AI, in `src/ai/contrast.ts`) — render the HTML server-side via Browser Rendering, screenshot, sample foreground/background, run WCAG luminance formula. Insert findings into `accessibility_audits`. If score < `A11Y_PASS_THRESHOLD` (85), keep status as `submitted` but mark `pdf_a11y_passed=0`.
6. **Embedding** — generate via `@cf/baai/bge-base-en-v1.5` (768-dim, MUST match existing `skippy-memory` index). Store the vector ID in `flyers.search_vector_id`. **Defer creating the new `def-flyers-search` Vectorize index until Phase 2 search lands** — for Phase 1 just persist the embedding bytes if you want, or skip.

After pipeline completes, set `status='ai_review'` (this status doesn't exist in the schema as an enum since `status` is just TEXT — that's fine, document it in code).

**Prompt versioning:** every prompt in `src/ai/prompts.ts` is exported as a const string with a `PROMPT_VERSION` constant. Whenever you edit a prompt, bump the version. Store `prompt_version` on every flyer for replay debugging.

**Cost budget:** ~$0.05/flyer through the full pipeline. If a single flyer goes over $0.20, log a warning. Use Anthropic prompt caching on the system prompts where it makes sense.

#### 2.4 — Admin reviewer queue
**Auth:** for now, gate `/api/admin/*` and `/admin` by checking `users.is_district_admin = 1`. Real Microsoft Entra ID OIDC is a separate task — Bateman has to provision the app registration first. For MVP, manually flip `is_district_admin=1` on Scott's user row after first magic-link login.

- `GET /api/admin/queue` — flyers where status in `('submitted','ai_review','reviewer')`, ordered by `submitted_at ASC`. Include AI verdict + a11y score.
- `GET /api/admin/flyer/:id` — full record including renders, audits, revisions.
- `POST /api/admin/flyer/:id/approve` body `{scheduled_send_at?}` — set status to `approved`, write `approved_by`, `approved_at`. If `scheduled_send_at` provided, status becomes `scheduled`. Insert into `admin_audit_log`.
- `POST /api/admin/flyer/:id/reject` body `{reason}` — set status to `rejected`, write `rejected_reason`. Email submitter via Resend with reason.
- `POST /api/admin/flyer/:id/request` body `{notes}` — set status to `draft`, email submitter with change requests, log to `flyer_revisions`.

**Build a simple HTML admin UI at `/admin`** (server-rendered, HTMX-powered for the action buttons). Don't build a React SPA. Patterns from the landing page apply: same color tokens, no JS unless needed.

#### 2.5 — Publishing & email delivery
- When a flyer is `approved` (or `scheduled` and the cron tick reaches its time):
  1. Render an accessible HTML version (EN and ES) and write to R2 as `flyers/{slug}/index.html` and `flyers/{slug}/index.es.html`.
  2. Set `status='published'`, write `published_at`.
  3. Find matching subscribers (`subscriptions.audience` matches flyer's audience, `school_ids` JSON column overlaps flyer's schools, `verified=1`, `active=1`, not in `suppressions`).
  4. Build a digest email (or single-flyer if urgent) using a React-Email-style template — for Phase 1, use raw HTML in a template literal in `src/email/templates/flyer-single.ts`. Inline-style everything.
  5. For each subscriber, insert a `deliveries` row, send via Resend for now (swap to SES once parent-digest volume demands it).

- Public route `GET /flyer/:slug` serves the published HTML from R2. Honor `?lang=es` toggle.

- Public route `GET /board` serves the flyer board (filtered by `school`, `category`, `audience`).

#### 2.6 — Subscriber opt-in
- `POST /api/parent/optin` body `{email, audience, school_ids, language}`
  - Email verification flow: insert `subscriptions` row with `verified=0`, generate `verification_token`, email magic-link-style verify URL.
  - On verify: set `verified=1`. Honor TCPA — store the consent text version they agreed to (use a `language_version` field on `subscriptions` or insert into a `consent_log` table — add migration `0004_consent_log.sql` that mirrors HANDOFF.md schema).
- `GET /api/parent/preferences` (authed via signed `unsubscribe_token` link) — return current prefs.
- `POST /api/parent/preferences` — update.
- `GET /unsubscribe?t=<unsubscribe_token>` — one-click STOP, sets `active=0`, inserts into `suppressions`.

---

## 3. Things you must NOT do

These are not negotiable. They come from Scott's standing rules.

1. **DO NOT use `sed` on production HTML files** anywhere — including any def-site or hiresbigh files if you happen across them. CSS-only edits, appended.
2. **DO NOT delete the existing `dsd-flyers` D1 database** — `def-flyers` reads from it. (You can delete the old `dsd-flyers` Worker, since it has no domain.)
3. **DO NOT change the existing schema** in `0001_init.sql`. Always add a new migration file.
4. **DO NOT switch the embedder** from `bge-base-en-v1.5` (768-dim) — it must match `skippy-memory`.
5. **DO NOT add entrance animations** to any hero or landing surface. Heroes stay still. No "Squarespace energy" — Scott will reject the PR.
6. **DO NOT use Bearer auth** when scripting against the Cloudflare API. Always `X-Auth-Email` + `X-Auth-Key`. (Wrangler handles this for you when env vars are set; only matters if you're hitting the REST API directly.)
7. **DO NOT use MailChannels** — discontinued. **DO NOT use Resend for bulk parent digests** (Phase 3+ goes to AWS SES). Phase 1 transactional volume on Resend is fine and is what we're shipping.
8. **DO NOT auto-publish flyers.** Phase 1 = 100% human review, even when AI verdict is green. The "green-lane auto-publish" feature is Phase 3 at earliest, and only after enough local data shows AI is right.
9. **DO NOT collect or store phone numbers / send SMS.** Phase 2. Twilio 10DLC isn't even submitted yet.
10. **DO NOT mix donation Stripe with flyer-revenue Stripe.** Don't add Stripe at all in Phase 1 — payments are end of Phase 1 / start of Phase 3.
11. **DO NOT commit secrets.** GitHub push protection will block. Use `wrangler secret put`.

---

## 4. Secrets to set before Phase 1 ships

```bash
# Anthropic Claude API (you'll need this for the AI pipeline)
wrangler secret put ANTHROPIC_API_KEY

# Resend (transactional email, Phase 1)
wrangler secret put RESEND_API_KEY
# API key from the DEF Resend account, scoped to flyers.daviskids.org

# Once SES production access is granted (Phase 3, ~24h after request):
wrangler secret put AWS_SES_KEY
wrangler secret put AWS_SES_SECRET
wrangler secret put AWS_SES_REGION  # e.g., us-west-2
```

DNS for email auth on `daviskids.org`:
- Phase 1 (Resend): SPF `v=spf1 include:_spf.resend.com ~all`, plus the DKIM TXT record Resend issues per domain
- Phase 3 (add SES): expand SPF to `v=spf1 include:_spf.resend.com include:amazonses.com ~all`, add the SES DKIM TXT records
- DMARC: `v=DMARC1; p=quarantine; rua=mailto:postmaster@daviskids.org`

Scott handles vendor account creation if not yet done. Ask before creating accounts in his name.

---

## 5. CI / quality gates

Before you ship anything:
- `npm run typecheck` must pass (`tsc --noEmit`)
- All `/api/*` routes return JSON with consistent error shape: `{error: 'code', message?: '...'}`
- All admin actions write to `admin_audit_log`
- Every flyer status change writes a `flyer_revisions` snapshot
- Manual smoke test: submit a flyer end-to-end through magic-link → AI → admin approve → email received

Codex doesn't have to set up GitHub Actions yet. That's fine for now. We'll add axe-core CI in a follow-up.

---

## 6. Verification commands

After any deploy, smoke test:
```bash
curl -s https://flyers.daviskids.org/health | python3 -m json.tool
curl -s https://flyers.daviskids.org/api/public/schools | python3 -c "import json,sys; print(len(json.load(sys.stdin)['schools']))"
curl -s https://flyers.daviskids.org/api/public/departments | python3 -c "import json,sys; print(len(json.load(sys.stdin)['departments']))"
curl -s https://flyers.daviskids.org/api/public/feed
```

Expected: 200s, schools=69, departments=10, feed=`{flyers:[],count:0}` until you publish one.

---

## 7. Open coordination items (Scott will resolve)

These are gating Phase 1 *finishing*, not starting. Build through them.

1. **Resend domain + DKIM** — Scott verifies `daviskids.org` in the existing Resend account and adds the DKIM/SPF records to the zone.
2. **AWS SES production access** — Phase 3 only; Scott files the request when bulk parent-digest volume justifies the swap (~24h to provision).
3. **Microsoft Entra app registration** — Scott has emailed Bateman; until ready, admin auth uses the `is_district_admin` flag on `users`.
4. **Twilio 10DLC** — Phase 2 only. Don't worry about it.
5. **Sherry/Kara sign-off on rate card** — Phase 3 only. Don't hardcode prices.
6. **Peachjar contract review** — Scott handles. No code impact.

---

## 8. Quick reference

- **Repo:** https://github.com/ramonscottf/def-flyers
- **Live:** https://flyers.daviskids.org
- **Account:** `77f3d6611f5ceab7651744268d434342`
- **Zone (daviskids.org):** `e9aac6e9fab72eae9eda35335bc47f40`
- **D1:** `dsd-flyers` (id `5b5de1d1-ca4a-4e27-bad5-f0a071a75b58`)
- **R2:** `dsd-flyers-assets`
- **KV:** `72249a65614a42f987b766e8ee616f68`
- **Vectorize index name (existing, shared):** `skippy-memory` (768-dim, cosine, bge-base-en-v1.5)
- **Wrangler auth:** Scott has Global API Key; use `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` env vars
- **GitHub PAT:** in Scott's memories; he'll provide if needed

If anything is ambiguous, **ask Scott in chat. Don't guess.** Build, don't explain.

— Skippy
