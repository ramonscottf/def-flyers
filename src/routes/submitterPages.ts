// Server-rendered submitter pages — no JS unless needed.
//   GET /submit          → magic-link form (or "you're signed in" if authed)
//   GET /submit/verify   → consume token from email, set cookie, redirect to /submit
//   POST /submit/magic   → form action that posts to /api/submitter/magic-link

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Bindings } from '../index';
import {
  SESSION_COOKIE,
  createSession,
  findOrCreateUserByEmail,
  loadSession,
  setSessionCookie,
  type AppVariables,
} from '../auth/session';
import { consumeMagicLink, issueMagicLink } from '../auth/magicLink';
import { rateLimit } from '../lib/rateLimit';
import { getTransactionalSender } from '../lib/email';
import { renderMagicLinkEmail } from '../email/templates/magicLink';

const pages = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageShell(opts: {
  title: string;
  body: string;
  status?: 'success' | 'error' | null;
  statusMessage?: string;
}) {
  const { title, body, status, statusMessage } = opts;
  const statusBlock =
    status && statusMessage
      ? `<div class="status status-${status}" role="status">${escapeHtml(statusMessage)}</div>`
      : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} · DEF Flyers</title>
<meta name="robots" content="noindex">
<style>
  :root {
    --navy: #0d1b3d; --navy-2: #1a2a5e; --gold: #c9a13b; --red: #b1252f;
    --bg: #ffffff; --card: #f3f5f9; --ink: #0d1b3d; --ink-2: #4a5876; --rule: #d8dde7;
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    color: var(--ink); background: var(--bg); line-height: 1.55; }
  a { color: var(--navy-2); }
  a:hover, a:focus { color: var(--red); }
  .skip-link { position:absolute; top:-40px; left:0; background: var(--navy); color:#fff;
    padding:8px 16px; z-index:100; }
  .skip-link:focus { top:0; }
  header.bar {
    background: var(--navy); color:#fff; padding: 20px 24px;
    border-bottom: 4px solid; border-image: linear-gradient(90deg,var(--navy-2),var(--red)) 1;
  }
  header.bar .inner { max-width: 720px; margin: 0 auto; display:flex; align-items:baseline;
    justify-content:space-between; gap: 16px; }
  header.bar h1 { margin:0; font-size: 22px; font-weight: 800; }
  header.bar .who { font-size: 13px; color:#d6dcec; }
  header.bar a { color: #d6dcec; }
  main { max-width: 560px; margin: 48px auto; padding: 0 24px 64px; }
  h2 { font-size: 24px; margin: 0 0 12px; color: var(--navy); }
  p { color: var(--ink-2); }
  .card { background: var(--card); border-radius: 12px; padding: 28px; }
  label { display:block; font-weight: 600; color: var(--navy); margin: 0 0 6px; font-size: 14px; }
  input[type=email] { width:100%; padding: 10px 12px; border: 1px solid var(--rule);
    border-radius: 8px; font-size: 16px; background:#fff; color: var(--ink); }
  input[type=email]:focus { outline: 2px solid var(--navy-2); outline-offset: 2px; }
  button.btn, .btn {
    display: inline-block; background: var(--navy); color: #fff;
    padding: 10px 20px; border-radius: 8px; border: none; font-weight: 600;
    font-size: 15px; cursor: pointer; text-decoration: none;
  }
  button.btn:hover, button.btn:focus, .btn:hover, .btn:focus { background: var(--red); }
  .row { margin-top: 14px; }
  .status { padding: 14px 18px; border-radius: 8px; font-size: 14px; margin: 0 0 24px; }
  .status-success { background: #e6f4ea; border: 1px solid #9bcdab; color: #1f4d2c; }
  .status-error { background: #fbeaea; border: 1px solid #e3a8ad; color: #6b1c22; }
  .muted { font-size: 13px; color: var(--ink-2); margin-top: 8px; }
  footer { border-top: 1px solid var(--rule); padding: 24px; text-align: center;
    color: var(--ink-2); font-size: 13px; }
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="bar">
  <div class="inner">
    <h1><a href="/" style="color:#fff;text-decoration:none;">DEF Flyers</a></h1>
    <span class="who"><a href="/">← Home</a></span>
  </div>
</header>
<main id="main">
  ${statusBlock}
  ${body}
</main>
<footer>
  <p>Davis Education Foundation · <a href="https://daviskids.org">daviskids.org</a></p>
</footer>
</body>
</html>`;
}

function magicLinkForm(opts: { prefillEmail?: string; status?: 'success' | 'error' | null; message?: string }) {
  const { prefillEmail = '', status = null, message } = opts;
  return pageShell({
    title: 'Sign in',
    status,
    statusMessage: message,
    body: `
      <h2>Sign in to submit a flyer</h2>
      <p>We'll email you a one-time link to sign in. No password to remember.</p>
      <div class="card">
        <form method="POST" action="/submit/magic" novalidate>
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" required autocomplete="email"
                 value="${escapeHtml(prefillEmail)}" placeholder="you@organization.org">
          <div class="row">
            <button type="submit" class="btn">Email me a sign-in link</button>
          </div>
          <p class="muted">Links expire in 15 minutes and can only be used once. We send no marketing email.</p>
        </form>
      </div>
    `,
  });
}

function signedInPage(opts: { email: string }) {
  return pageShell({
    title: 'Submit a flyer',
    body: `
      <h2>You're signed in</h2>
      <p>Signed in as <strong>${escapeHtml(opts.email)}</strong>.</p>
      <div class="card">
        <p>The submission form will be available soon. Thank you for your patience while we finish wiring it up.</p>
        <form method="POST" action="/api/submitter/logout" style="margin-top: 8px;">
          <button type="submit" class="btn">Sign out</button>
        </form>
      </div>
    `,
  });
}

// ─── GET /submit ───────────────────────────────────────────────────────────
pages.get('/submit', async (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    const user = await loadSession(c.env, sid);
    if (user) return c.html(signedInPage({ email: user.email }));
  }
  return c.html(magicLinkForm({}));
});

// ─── POST /submit/magic ────────────────────────────────────────────────────
// Form-encoded fallback that re-uses the API logic.
pages.post('/submit/magic', async (c) => {
  const form = await c.req.parseBody();
  const email = (typeof form.email === 'string' ? form.email : '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return c.html(
      magicLinkForm({
        prefillEmail: email,
        status: 'error',
        message: 'Please enter a valid email address.',
      }),
      400,
    );
  }

  const limit = await rateLimit(c.env, `ratelimit:magic:${email}`, 3, 3600);
  if (!limit.allowed) {
    return c.html(
      magicLinkForm({
        prefillEmail: email,
        status: 'error',
        message: 'Too many sign-in attempts for this address. Please try again later.',
      }),
      429,
    );
  }

  const ip =
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined;
  const ttlMinutes = parseInt(c.env.MAGIC_LINK_TTL_MINUTES ?? '15', 10);

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const { url } = await issueMagicLink(c.env, email, ip);
        const sender = getTransactionalSender(c.env);
        const { subject, html, text } = renderMagicLinkEmail({ url, ttlMinutes });
        await sender.send({ to: email, subject, html, text, tag: 'magic-link' });
      } catch (err) {
        console.error('[magic-link] send failed:', email, err);
      }
    })(),
  );

  return c.html(
    magicLinkForm({
      status: 'success',
      message: `If ${email} is valid, a sign-in link is on its way. Check your inbox in a moment.`,
    }),
  );
});

// ─── GET /submit/verify ────────────────────────────────────────────────────
// Consumes the magic-link token from the email, sets the session cookie,
// and redirects to /submit. Friendly to no-JS clients.
pages.get('/submit/verify', async (c) => {
  const token = c.req.query('token') ?? '';
  if (!token) {
    return c.html(
      magicLinkForm({
        status: 'error',
        message: 'That sign-in link is missing a token. Please request a new one.',
      }),
      400,
    );
  }

  const consumed = await consumeMagicLink(c.env, token);
  if (!consumed) {
    return c.html(
      magicLinkForm({
        status: 'error',
        message:
          'That sign-in link is invalid, expired, or already used. Please request a new one.',
      }),
      400,
    );
  }

  const user = await findOrCreateUserByEmail(c.env, consumed.email);
  const session = await createSession(
    c.env,
    user.id,
    c.req.header('cf-connecting-ip') ?? undefined,
    c.req.header('user-agent') ?? undefined,
  );
  setSessionCookie(c, session.id, session.expiresAt);
  return c.redirect('/submit', 303);
});

export default pages;
