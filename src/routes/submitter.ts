import { Hono } from 'hono';
import type { Bindings } from '../index';
import {
  type AppVariables,
  clearSessionCookie,
  createSession,
  findOrCreateUserByEmail,
  requireSession,
  setSessionCookie,
} from '../auth/session';
import { consumeMagicLink, issueMagicLink } from '../auth/magicLink';
import { rateLimit } from '../lib/rateLimit';
import { getTransactionalSender } from '../lib/email';
import { renderMagicLinkEmail } from '../email/templates/magicLink';

const api = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined;
}

// ─── POST /api/submitter/magic-link ────────────────────────────────────────
// Body: {email}. Always returns {ok:true} — no enumeration leak.
// Rate-limited 3/hour/email via KV.
api.post('/magic-link', async (c) => {
  let body: { email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !EMAIL_RE.test(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }

  const limit = await rateLimit(c.env, `ratelimit:magic:${email}`, 3, 3600);
  if (!limit.allowed) {
    return c.json(
      { error: 'rate_limited', message: 'Too many requests. Try again later.' },
      429,
    );
  }

  const ip = clientIp(c);
  const ttlMinutes = parseInt(c.env.MAGIC_LINK_TTL_MINUTES ?? '15', 10);

  // Best-effort send. We don't expose failures to the client to avoid
  // enumeration leaks; we log so operators can see Postmark issues.
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

  return c.json({ ok: true });
});

// ─── POST /api/submitter/verify ────────────────────────────────────────────
// Body: {token}. Consumes the magic link, creates session, sets cookie.
api.post('/verify', async (c) => {
  let body: { token?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return c.json({ error: 'invalid_token' }, 400);

  const consumed = await consumeMagicLink(c.env, token);
  if (!consumed) return c.json({ error: 'invalid_or_expired' }, 400);

  const user = await findOrCreateUserByEmail(c.env, consumed.email);
  const session = await createSession(
    c.env,
    user.id,
    clientIp(c),
    c.req.header('user-agent') ?? undefined,
  );
  setSessionCookie(c, session.id, session.expiresAt);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      is_employee: user.is_employee,
      is_district_admin: user.is_district_admin,
    },
  });
});

// ─── GET /api/submitter/me ─────────────────────────────────────────────────
api.get('/me', requireSession(), (c) => {
  const user = c.get('user');
  return c.json({ user });
});

// ─── POST /api/submitter/logout ────────────────────────────────────────────
api.post('/logout', async (c) => {
  const sessionId = c.get('sessionId');
  // Tolerant: clear cookie even if no active session.
  if (sessionId) {
    await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ─── Phase 1 stubs (filled by section 2.2) ─────────────────────────────────
api.post('/submit', requireSession(), (c) =>
  c.json({ error: 'not_implemented_yet', phase: 1, section: '2.2' }, 501),
);
api.post('/submit/upload-url', requireSession(), (c) =>
  c.json({ error: 'not_implemented_yet', phase: 1, section: '2.2' }, 501),
);
api.get('/flyer/:id', requireSession(), (c) =>
  c.json({ error: 'not_implemented_yet', phase: 1, section: '2.2' }, 501),
);
api.patch('/flyer/:id', requireSession(), (c) =>
  c.json({ error: 'not_implemented_yet', phase: 1, section: '2.2' }, 501),
);
api.post('/flyer/:id/finalize', requireSession(), (c) =>
  c.json({ error: 'not_implemented_yet', phase: 1, section: '2.2' }, 501),
);

export default api;
