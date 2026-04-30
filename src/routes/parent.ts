// Public subscriber opt-in surface. Both an HTML page set (for the human
// flow) and a small JSON API for programmatic clients (e.g. opt-in widget
// embedded in a school site).
//
// Pages:
//   GET  /parent                 opt-in form
//   POST /parent/optin           form-encoded handler → email verify link
//   GET  /verify-subscription?t= flip verified=1, log consent, show success
//   GET  /preferences?t=         per-subscriber prefs (gated by unsub token)
//   POST /preferences?t=         update prefs
//   GET  /unsubscribe?t=         confirm + execute one-click STOP
//   POST /unsubscribe            (form-encoded fallback)
//
// API:
//   POST /api/parent/optin       JSON {email, audience, school_ids, language}
//   POST /api/parent/unsubscribe JSON {token}
//
// All consent state changes write a consent_log row with the exact policy
// version the subscriber agreed to (TCPA evidence).

import { Hono } from 'hono';
import type { Bindings } from '../index';
import { rateLimit } from '../lib/rateLimit';
import { ulid } from '../lib/ulid';
import { getTransactionalSender } from '../lib/email';
import { renderParentVerifyEmail } from '../email/templates/parentVerify';

const pages = new Hono<{ Bindings: Bindings }>();

// Bump on any policy text change so the consent_log captures it.
const CONSENT_POLICY_VERSION = '2026-04-29.1';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CONSENT_TEXT = {
  en: 'I agree to receive DEF Flyers email from Davis Education Foundation in partnership with Davis School District. I understand I can unsubscribe at any time using the link in every email.',
  es: 'Acepto recibir correos electrónicos de DEF Flyers de Davis Education Foundation en colaboración con Davis School District. Entiendo que puedo cancelar mi suscripción en cualquier momento usando el enlace en cada correo electrónico.',
} as const;

function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined;
}

interface FormSelections {
  email: string;
  language: 'en' | 'es';
  schoolIds: string[];
  consent: boolean;
}

async function listSchools(env: Bindings): Promise<{ id: string; name: string; level: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, level FROM schools WHERE active = 1
     ORDER BY CASE level WHEN 'district' THEN 0 WHEN 'high' THEN 1 WHEN 'junior' THEN 2 WHEN 'elementary' THEN 3 ELSE 4 END, name`,
  ).all<{ id: string; name: string; level: string }>();
  return results;
}

interface RenderFormOpts {
  schools: { id: string; name: string; level: string }[];
  selection?: FormSelections;
  flash?: { kind: 'success' | 'error'; message: string };
}

function renderOptinPage(opts: RenderFormOpts): string {
  const sel = opts.selection ?? { email: '', language: 'en', schoolIds: [], consent: false };
  const schoolBoxes = opts.schools
    .map((s) => `<label class="check"><input type="checkbox" name="schools" value="${escapeHtml(s.id)}"${sel.schoolIds.includes(s.id) ? ' checked' : ''}> ${escapeHtml(s.name)} <span class="lvl">${escapeHtml(s.level)}</span></label>`)
    .join('');
  const flash = opts.flash
    ? `<div class="flash flash-${opts.flash.kind}" role="status">${escapeHtml(opts.flash.message)}</div>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign up · DEF Flyers</title>
<style>${SHARED_CSS}
  .check{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer}
  .check:hover{background:#eef1fa}
  .check input{margin:0}
  .check .lvl{margin-left:auto;font-size:12px;color:var(--ink-2);text-transform:uppercase}
  .schools{max-height:300px;overflow:auto;border:1px solid var(--rule);border-radius:8px;padding:6px;background:#fff;margin:0 0 12px}
  fieldset{border:1px solid var(--rule);border-radius:8px;padding:10px 12px;margin:0 0 12px}
  legend{padding:0 6px;font-size:13px;color:var(--ink-2);font-weight:600}
  .lang label{margin-right:16px}
  .consent{font-size:13px;color:var(--ink-2);margin:0 0 4px}
</style></head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="bar"><div class="inner"><h1><a href="/" style="color:#fff;text-decoration:none;">DEF Flyers</a></h1><a href="/board">Board</a></div></header>
<main id="main">
  ${flash}
  <h2>Sign up for DEF Flyers</h2>
  <p>Get the flyers and announcements that matter for your kids' schools. Pick which schools and language. Unsubscribe anytime with one click.</p>
  <form method="POST" action="/parent/optin" novalidate>
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(sel.email)}" placeholder="you@email.com">

    <fieldset class="lang"><legend>Language preference</legend>
      <label><input type="radio" name="language" value="en"${sel.language === 'en' ? ' checked' : ''}> English</label>
      <label><input type="radio" name="language" value="es"${sel.language === 'es' ? ' checked' : ''}> Español</label>
    </fieldset>

    <fieldset><legend>Schools (optional — leave empty for all)</legend>
      <div class="schools">${schoolBoxes}</div>
    </fieldset>

    <p class="consent">${escapeHtml(CONSENT_TEXT.en)}</p>
    <label class="check"><input type="checkbox" name="consent" value="1"${sel.consent ? ' checked' : ''} required> I agree</label>

    <button type="submit" class="btn" style="margin-top:10px;">Send confirmation email</button>
    <p class="consent" style="margin-top:12px;">By signing up you agree to our <a href="/policies/privacy">privacy policy</a>. We'll send a confirmation email — your subscription is not active until you click the link in it.</p>
  </form>
</main>
<footer>Davis Education Foundation · <a href="https://daviskids.org">daviskids.org</a></footer>
</body></html>`;
}

const SHARED_CSS = `:root{--navy:#0d1b3d;--navy-2:#1a2a5e;--gold:#c9a13b;--red:#b1252f;--bg:#fff;--card:#f3f5f9;--ink:#0d1b3d;--ink-2:#4a5876;--rule:#d8dde7}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--bg);line-height:1.55}
a{color:var(--navy-2)}a:hover,a:focus{color:var(--red)}
.skip-link{position:absolute;top:-40px;left:0;background:var(--navy);color:#fff;padding:8px 16px;z-index:100}
.skip-link:focus{top:0}
header.bar{background:var(--navy);color:#fff;padding:14px 24px;border-bottom:4px solid;border-image:linear-gradient(90deg,var(--navy-2),var(--red)) 1}
header.bar .inner{max-width:760px;margin:0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:16px}
header.bar h1{margin:0;font-size:18px;font-weight:800}
header.bar a{color:#d6dcec;text-decoration:none}
main{max-width:640px;margin:32px auto;padding:0 24px 64px}
h2{font-size:24px;margin:0 0 12px;color:var(--navy)}
p{color:var(--ink-2)}
form{background:var(--card);border-radius:12px;padding:20px;margin-top:16px}
label{display:block;font-weight:600;color:var(--navy);margin:0 0 6px;font-size:14px}
input[type=email],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--rule);border-radius:8px;font-size:16px;background:#fff;color:var(--ink);margin-bottom:12px}
input[type=email]:focus,input[type=text]:focus{outline:2px solid var(--navy-2);outline-offset:2px}
.btn{display:inline-block;background:var(--navy);color:#fff;padding:10px 20px;border-radius:8px;border:none;font-weight:600;font-size:15px;cursor:pointer;text-decoration:none}
.btn:hover,.btn:focus{background:var(--red)}
.btn.danger{background:var(--red)}.btn.danger:hover{background:#7c1820}
.flash{padding:12px 16px;border-radius:8px;margin:0 0 16px;font-size:14px}
.flash-success{background:#e6f4ea;border:1px solid #9bcdab;color:#1f4d2c}
.flash-error{background:#fbeaea;border:1px solid #e3a8ad;color:#6b1c22}
footer{border-top:1px solid var(--rule);padding:20px 24px;text-align:center;color:var(--ink-2);font-size:13px;margin-top:48px}`;

function infoPage(opts: { title: string; body: string }): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)} · DEF Flyers</title>
<style>${SHARED_CSS}</style></head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="bar"><div class="inner"><h1><a href="/" style="color:#fff;text-decoration:none;">DEF Flyers</a></h1><a href="/board">Board</a></div></header>
<main id="main">${opts.body}</main>
<footer>Davis Education Foundation · <a href="https://daviskids.org">daviskids.org</a></footer>
</body></html>`;
}

function parseFormSelections(form: Record<string, string | File | (string | File)[]>): FormSelections {
  const email = (typeof form.email === 'string' ? form.email : '').trim().toLowerCase();
  const langRaw = typeof form.language === 'string' ? form.language : 'en';
  const language: 'en' | 'es' = langRaw === 'es' ? 'es' : 'en';
  let schoolIds: string[] = [];
  if (Array.isArray(form.schools)) {
    schoolIds = form.schools.filter((v): v is string => typeof v === 'string');
  } else if (typeof form.schools === 'string') {
    schoolIds = [form.schools];
  }
  const consent = !!form.consent;
  return { email, language, schoolIds, consent };
}

async function logConsent(
  env: Bindings,
  args: {
    subscriptionId: number | null;
    email: string;
    channel: 'email';
    action: 'optin' | 'verify' | 'optout' | 'preference_change';
    sourceUrl: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO consent_log
       (subscription_id, email, channel, action, language_version, source_url, ip, user_agent, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.subscriptionId,
      args.email,
      args.channel,
      args.action,
      CONSENT_POLICY_VERSION,
      args.sourceUrl,
      args.ip ?? null,
      args.userAgent ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

async function suppress(
  env: Bindings,
  channel: 'email',
  identifier: string,
  reason: 'stop' | 'bounce' | 'complaint' | 'manual',
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO suppressions (channel, identifier, reason, recorded_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(channel, identifier.toLowerCase(), reason, Math.floor(Date.now() / 1000))
    .run();
}

// ─── GET /parent ───────────────────────────────────────────────────────────
pages.get('/parent', async (c) => {
  const schools = await listSchools(c.env);
  return c.html(renderOptinPage({ schools }));
});

// ─── POST /parent/optin (form) + POST /api/parent/optin (JSON) ─────────────
async function handleOptin(
  c: import('hono').Context<{ Bindings: Bindings }>,
  payload: FormSelections,
): Promise<{ ok: true; email: string } | { ok: false; error: string; status: 400 | 429 }> {
  if (!payload.email || !EMAIL_RE.test(payload.email)) {
    return { ok: false, error: 'invalid_email', status: 400 };
  }
  if (!payload.consent) {
    return { ok: false, error: 'consent_required', status: 400 };
  }

  // Don't even start if the address is suppressed.
  const suppressed = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM suppressions WHERE channel = 'email' AND identifier = ? LIMIT 1`,
  )
    .bind(payload.email)
    .first();
  if (suppressed) {
    // Soft-success — no enumeration leak.
    return { ok: true, email: payload.email };
  }

  // Rate limit per-email so the verify-mail endpoint can't be used as a flood vector.
  const limit = await rateLimit(c.env, `ratelimit:optin:${payload.email}`, 3, 3600);
  if (!limit.allowed) {
    return { ok: false, error: 'rate_limited', status: 429 };
  }

  // Validate school ids against the seeded set.
  if (payload.schoolIds.length > 0) {
    const placeholders = payload.schoolIds.map(() => '?').join(',');
    const found = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM schools WHERE id IN (${placeholders}) AND active = 1`,
    )
      .bind(...payload.schoolIds)
      .first<{ n: number }>();
    if (!found || found.n !== payload.schoolIds.length) {
      return { ok: false, error: 'unknown_school', status: 400 };
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const verifyToken = ulid().toLowerCase();
  const unsubscribeToken = ulid().toLowerCase();

  // Upsert: if there's already a row for this email keep it, otherwise insert.
  const existing = await c.env.DB.prepare(
    `SELECT id, verified, active FROM subscriptions WHERE email = ?`,
  )
    .bind(payload.email)
    .first<{ id: number; verified: number; active: number }>();

  let subscriptionId: number;
  if (existing) {
    subscriptionId = existing.id;
    await c.env.DB.prepare(
      `UPDATE subscriptions
       SET audience = 'parents',
           school_ids = ?,
           language = ?,
           ${existing.verified === 1 ? '' : 'verification_token = ?,'}
           active = 1,
           ${existing.verified === 1 ? '' : 'verified = 0,'}
           digest_frequency = 'weekly',
           delivery = 'email',
           ${existing.verified === 1 ? '' : 'unsubscribe_token = ?,'}
           source = 'self_signup'
       WHERE id = ?`,
    )
      .bind(
        ...(existing.verified === 1
          ? [JSON.stringify(payload.schoolIds), payload.language, subscriptionId]
          : [JSON.stringify(payload.schoolIds), payload.language, verifyToken, unsubscribeToken, subscriptionId]),
      )
      .run();
  } else {
    const ins = await c.env.DB.prepare(
      `INSERT INTO subscriptions
         (email, audience, school_ids, language, digest_frequency, delivery,
          active, verified, verification_token, unsubscribe_token,
          created_at, source)
       VALUES (?, 'parents', ?, ?, 'weekly', 'email', 1, 0, ?, ?, ?, 'self_signup')`,
    )
      .bind(
        payload.email,
        JSON.stringify(payload.schoolIds),
        payload.language,
        verifyToken,
        unsubscribeToken,
        now,
      )
      .run();
    subscriptionId = ins.meta.last_row_id ?? 0;
  }

  await logConsent(c.env, {
    subscriptionId,
    email: payload.email,
    channel: 'email',
    action: 'optin',
    sourceUrl: '/parent/optin',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? undefined,
  });

  // Don't email an already-verified subscriber a fresh confirmation —
  // they're already signed up. Email only if they're new or unverified.
  if (!existing || existing.verified !== 1) {
    const baseUrl = c.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    const url = `${baseUrl}/verify-subscription?t=${encodeURIComponent(verifyToken)}`;

    c.executionCtx.waitUntil(
      (async () => {
        try {
          const sender = getTransactionalSender(c.env);
          const { subject, html, text } = renderParentVerifyEmail({ url, language: payload.language });
          await sender.send({ to: payload.email, subject, html, text, tag: 'parent-verify' });
        } catch (err) {
          console.error('[parent/optin] verify email failed', err);
        }
      })(),
    );
  }

  return { ok: true, email: payload.email };
}

pages.post('/parent/optin', async (c) => {
  const form = await c.req.parseBody();
  const sel = parseFormSelections(form);
  const r = await handleOptin(c, sel);
  const schools = await listSchools(c.env);

  if (!r.ok) {
    const messages: Record<string, string> = {
      invalid_email: 'Please enter a valid email address.',
      consent_required: 'You need to agree to the consent statement before signing up.',
      unknown_school: 'One of the selected schools is not in our list.',
      rate_limited: 'Too many sign-up attempts for this email. Please try again later.',
    };
    return c.html(
      renderOptinPage({
        schools,
        selection: sel,
        flash: { kind: 'error', message: messages[r.error] ?? r.error },
      }),
      r.status,
    );
  }

  return c.html(infoPage({
    title: 'Check your email',
    body: `<h2>Check your email</h2>
<p>Confirmation sent to <strong>${escapeHtml(r.email)}</strong>. Click the link in that email to activate your subscription. The link expires in 24 hours.</p>
<p>Didn't get it? Check your spam folder, or <a href="/parent">try again</a>.</p>`,
  }));
});

// ─── GET /verify-subscription ──────────────────────────────────────────────
pages.get('/verify-subscription', async (c) => {
  const token = c.req.query('t') ?? '';
  if (!token) {
    return c.html(infoPage({
      title: 'Missing token',
      body: '<h2>Missing token</h2><p>This verification link is missing the token. Please use the exact link from the email we sent.</p>',
    }), 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, email, verified FROM subscriptions WHERE verification_token = ?`,
  )
    .bind(token)
    .first<{ id: number; email: string; verified: number }>();
  if (!row) {
    return c.html(infoPage({
      title: 'Link not valid',
      body: '<h2>Link not valid</h2><p>That verification link is invalid or has already been used.</p><p><a href="/parent">Sign up again</a> if needed.</p>',
    }), 400);
  }

  if (row.verified !== 1) {
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      `UPDATE subscriptions SET verified = 1, active = 1, verification_token = NULL WHERE id = ?`,
    )
      .bind(row.id)
      .run();
    await logConsent(c.env, {
      subscriptionId: row.id,
      email: row.email,
      channel: 'email',
      action: 'verify',
      sourceUrl: '/verify-subscription',
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? undefined,
    });
  }

  return c.html(infoPage({
    title: 'You\'re subscribed',
    body: `<h2>You're subscribed</h2>
<p>Thanks, ${escapeHtml(row.email)}. You'll start receiving DEF Flyers when new ones publish for your selected schools.</p>
<p><a href="/board">Browse the flyer board →</a></p>`,
  }));
});

// ─── GET /preferences (?t=unsubscribe_token) ───────────────────────────────
pages.get('/preferences', async (c) => {
  const token = c.req.query('t') ?? '';
  if (!token) return c.html(infoPage({ title: 'Missing token', body: '<h2>Missing token</h2><p>This page needs a token from one of your DEF Flyers emails.</p>' }), 400);
  const sub = await c.env.DB.prepare(
    `SELECT id, email, school_ids, language, active FROM subscriptions WHERE unsubscribe_token = ?`,
  )
    .bind(token)
    .first<{ id: number; email: string; school_ids: string | null; language: string | null; active: number }>();
  if (!sub) return c.html(infoPage({ title: 'Link not valid', body: '<h2>Link not valid</h2>' }), 400);
  const schools = await listSchools(c.env);
  let selectedSchools: string[] = [];
  try { selectedSchools = sub.school_ids ? JSON.parse(sub.school_ids) : []; } catch {}
  const sel: FormSelections = {
    email: sub.email,
    language: sub.language === 'es' ? 'es' : 'en',
    schoolIds: selectedSchools,
    consent: true,
  };

  const schoolBoxes = schools
    .map((s) => `<label class="check"><input type="checkbox" name="schools" value="${escapeHtml(s.id)}"${sel.schoolIds.includes(s.id) ? ' checked' : ''}> ${escapeHtml(s.name)} <span class="lvl">${escapeHtml(s.level)}</span></label>`)
    .join('');

  const body = `<h2>Email preferences</h2>
<p>Signed in as <strong>${escapeHtml(sub.email)}</strong>. Status: ${sub.active === 1 ? 'active' : 'unsubscribed'}.</p>
<form method="POST" action="/preferences?t=${encodeURIComponent(token)}">
  <fieldset class="lang"><legend>Language preference</legend>
    <label><input type="radio" name="language" value="en"${sel.language === 'en' ? ' checked' : ''}> English</label>
    <label><input type="radio" name="language" value="es"${sel.language === 'es' ? ' checked' : ''}> Español</label>
  </fieldset>
  <fieldset><legend>Schools (leave empty for all)</legend>
    <div class="schools">${schoolBoxes}</div>
  </fieldset>
  <button class="btn" type="submit">Save preferences</button>
</form>
<form method="POST" action="/unsubscribe" style="margin-top:16px;">
  <input type="hidden" name="t" value="${escapeHtml(token)}">
  <button class="btn danger" type="submit">Unsubscribe from all DEF Flyers</button>
</form>`;
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Preferences · DEF Flyers</title>
<style>${SHARED_CSS}
  .check{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px}
  .check:hover{background:#eef1fa}.check .lvl{margin-left:auto;font-size:12px;color:var(--ink-2);text-transform:uppercase}
  .schools{max-height:300px;overflow:auto;border:1px solid var(--rule);border-radius:8px;padding:6px;background:#fff;margin:0 0 12px}
  fieldset{border:1px solid var(--rule);border-radius:8px;padding:10px 12px;margin:0 0 12px}
  legend{padding:0 6px;font-size:13px;color:var(--ink-2);font-weight:600}
  .lang label{margin-right:16px}
</style></head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="bar"><div class="inner"><h1><a href="/" style="color:#fff;text-decoration:none;">DEF Flyers</a></h1><a href="/board">Board</a></div></header>
<main id="main">${body}</main>
<footer>Davis Education Foundation · <a href="https://daviskids.org">daviskids.org</a></footer>
</body></html>`);
});

// ─── POST /preferences ─────────────────────────────────────────────────────
pages.post('/preferences', async (c) => {
  const token = c.req.query('t') ?? '';
  if (!token) return c.html(infoPage({ title: 'Missing token', body: '<h2>Missing token</h2>' }), 400);
  const sub = await c.env.DB.prepare(
    `SELECT id, email FROM subscriptions WHERE unsubscribe_token = ?`,
  )
    .bind(token)
    .first<{ id: number; email: string }>();
  if (!sub) return c.html(infoPage({ title: 'Link not valid', body: '<h2>Link not valid</h2>' }), 400);

  const form = await c.req.parseBody();
  const sel = parseFormSelections({ ...form, consent: '1' });

  if (sel.schoolIds.length > 0) {
    const placeholders = sel.schoolIds.map(() => '?').join(',');
    const found = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM schools WHERE id IN (${placeholders}) AND active = 1`,
    )
      .bind(...sel.schoolIds)
      .first<{ n: number }>();
    if (!found || found.n !== sel.schoolIds.length) {
      return c.html(infoPage({ title: 'Invalid school', body: '<h2>Invalid school</h2><p>One of the selected schools is not in our list.</p>' }), 400);
    }
  }

  await c.env.DB.prepare(
    `UPDATE subscriptions SET school_ids = ?, language = ?, active = 1 WHERE id = ?`,
  )
    .bind(JSON.stringify(sel.schoolIds), sel.language, sub.id)
    .run();

  await logConsent(c.env, {
    subscriptionId: sub.id,
    email: sub.email,
    channel: 'email',
    action: 'preference_change',
    sourceUrl: '/preferences',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? undefined,
  });

  return c.html(infoPage({
    title: 'Preferences saved',
    body: '<h2>Preferences saved</h2><p>Your changes are in effect right now.</p><p><a href="/board">Back to the flyer board</a></p>',
  }));
});

// ─── GET /unsubscribe ──────────────────────────────────────────────────────
pages.get('/unsubscribe', async (c) => {
  const token = c.req.query('t') ?? '';
  if (!token) {
    return c.html(infoPage({
      title: 'Unsubscribe',
      body: '<h2>Unsubscribe</h2><p>This page needs the token from your DEF Flyers email. Use the unsubscribe link in any DEF Flyers email and you\'ll land here automatically.</p>',
    }), 400);
  }
  const sub = await c.env.DB.prepare(
    `SELECT id, email, active FROM subscriptions WHERE unsubscribe_token = ?`,
  )
    .bind(token)
    .first<{ id: number; email: string; active: number }>();
  if (!sub) {
    return c.html(infoPage({
      title: 'Link not valid',
      body: '<h2>Link not valid</h2><p>That unsubscribe link is invalid or already used.</p>',
    }), 400);
  }

  // One-click confirm form. RFC 8058 / Gmail one-click expects POST; the GET
  // page asks for one click of the button to fulfil that contract while
  // still being a "single click" experience for the user.
  const body = `<h2>Unsubscribe ${escapeHtml(sub.email)}?</h2>
<p>Status: ${sub.active === 1 ? 'currently subscribed' : 'already unsubscribed'}.</p>
<form method="POST" action="/unsubscribe">
  <input type="hidden" name="t" value="${escapeHtml(token)}">
  <button class="btn danger" type="submit">Yes, unsubscribe me</button>
</form>
<p style="margin-top:16px;font-size:13px;color:var(--ink-2);">If you'd rather adjust preferences, <a href="/preferences?t=${encodeURIComponent(token)}">manage your preferences</a>.</p>`;
  return c.html(infoPage({ title: 'Unsubscribe', body }));
});

// ─── POST /unsubscribe ─────────────────────────────────────────────────────
pages.post('/unsubscribe', async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.t === 'string' ? form.t : '';
  if (!token) {
    return c.html(infoPage({ title: 'Missing token', body: '<h2>Missing token</h2>' }), 400);
  }
  const sub = await c.env.DB.prepare(
    `SELECT id, email, active FROM subscriptions WHERE unsubscribe_token = ?`,
  )
    .bind(token)
    .first<{ id: number; email: string; active: number }>();
  if (!sub) {
    return c.html(infoPage({ title: 'Link not valid', body: '<h2>Link not valid</h2>' }), 400);
  }

  if (sub.active === 1) {
    await c.env.DB.prepare(
      `UPDATE subscriptions SET active = 0 WHERE id = ?`,
    )
      .bind(sub.id)
      .run();
  }
  await suppress(c.env, 'email', sub.email, 'stop');
  await logConsent(c.env, {
    subscriptionId: sub.id,
    email: sub.email,
    channel: 'email',
    action: 'optout',
    sourceUrl: '/unsubscribe',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? undefined,
  });

  return c.html(infoPage({
    title: 'Unsubscribed',
    body: `<h2>You're unsubscribed</h2><p>${escapeHtml(sub.email)} will no longer receive DEF Flyers email. You can <a href="/parent">re-subscribe at any time</a>.</p>`,
  }));
});

// ─── JSON API: POST /api/parent/optin ──────────────────────────────────────
const api = new Hono<{ Bindings: Bindings }>();

api.post('/optin', async (c) => {
  let body: { email?: unknown; language?: unknown; school_ids?: unknown; consent?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const sel: FormSelections = {
    email: typeof body.email === 'string' ? body.email.trim().toLowerCase() : '',
    language: body.language === 'es' ? 'es' : 'en',
    schoolIds: Array.isArray(body.school_ids)
      ? body.school_ids.filter((s: unknown): s is string => typeof s === 'string')
      : [],
    consent: !!body.consent,
  };
  const r = await handleOptin(c, sel);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true });
});

api.post('/unsubscribe', async (c) => {
  let body: { token?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return c.json({ error: 'invalid_token' }, 400);
  const sub = await c.env.DB.prepare(
    `SELECT id, email, active FROM subscriptions WHERE unsubscribe_token = ?`,
  )
    .bind(token)
    .first<{ id: number; email: string; active: number }>();
  if (!sub) return c.json({ error: 'invalid_token' }, 400);
  if (sub.active === 1) {
    await c.env.DB.prepare(`UPDATE subscriptions SET active = 0 WHERE id = ?`).bind(sub.id).run();
  }
  await suppress(c.env, 'email', sub.email, 'stop');
  await logConsent(c.env, {
    subscriptionId: sub.id,
    email: sub.email,
    channel: 'email',
    action: 'optout',
    sourceUrl: '/api/parent/unsubscribe',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? undefined,
  });
  return c.json({ ok: true });
});

export { pages as parentPages, api as parentApi };
