import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';
import { renderLanding } from './routes/landing';
import publicApi from './routes/public';
import publicPages from './routes/publicPages';
import submitterApi from './routes/submitter';
import submitterFlyersApi from './routes/submitterFlyers';
import submitterPages from './routes/submitterPages';
import adminApi from './routes/admin';
import adminPages from './routes/adminPages';
import { runScheduledPublishes } from './publish';

export type Bindings = {
  DB: D1Database;
  ASSETS: R2Bucket;
  KV: KVNamespace;
  AI: Ai;
  BROWSER: Fetcher;
  ENVIRONMENT: string;
  PUBLIC_BASE_URL: string;
  ALLOWED_EMAIL_DOMAINS: string;
  EMPLOYEE_EMAIL_DOMAIN: string;
  SESSION_TTL_DAYS: string;
  MAGIC_LINK_TTL_MINUTES: string;
  TARGET_READING_GRADE: string;
  A11Y_PASS_THRESHOLD: string;
  // Secrets
  ANTHROPIC_API_KEY?: string;
  RESEND_API_KEY?: string;
  AWS_SES_KEY?: string;
  AWS_SES_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', logger());
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'"],
    fontSrc: ["'self'", 'data:'],
  },
}));
app.use('/api/*', cors({
  origin: (origin, c) => {
    const base = c.env.PUBLIC_BASE_URL;
    if (!origin || origin === base) return origin ?? base;
    return null;
  },
  credentials: true,
}));

// ─── Health ──────────────────────────────────────────────────────────────
app.get('/health', async (c) => {
  const dbCheck = await c.env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>();
  return c.json({
    ok: true,
    service: 'def-flyers',
    env: c.env.ENVIRONMENT,
    db: dbCheck?.ok === 1 ? 'up' : 'down',
    ts: Date.now(),
  });
});

// ─── Landing page (public, no JS) ────────────────────────────────────────
app.get('/', async (c) => {
  // Show counts so the landing isn't lying
  const stats = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM schools WHERE active = 1) AS school_count,
      (SELECT COUNT(*) FROM departments WHERE active = 1) AS dept_count,
      (SELECT COUNT(*) FROM flyers WHERE status = 'published') AS published_count
  `).first<{ school_count: number; dept_count: number; published_count: number }>();

  return c.html(renderLanding({
    schools: stats?.school_count ?? 0,
    depts: stats?.dept_count ?? 0,
    flyers: stats?.published_count ?? 0,
  }));
});

// ─── Submitter pages (magic-link form, verify) ───────────────────────────
app.route('/', submitterPages);

// ─── Public pages (flyer detail, board, asset proxy, unsubscribe) ────────
app.route('/', publicPages);

// ─── Admin reviewer pages (gated by is_district_admin) ───────────────────
app.route('/admin', adminPages);

// ─── API routes ──────────────────────────────────────────────────────────
app.route('/api/public', publicApi);
app.route('/api/submitter', submitterApi);
app.route('/api/submitter', submitterFlyersApi);
app.route('/api/admin', adminApi);

// ─── 404 ─────────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

app.onError((err, c) => {
  console.error('def-flyers error:', err);
  return c.json({ error: 'internal_error', message: err.message }, 500);
});

// Cloudflare Workers entry — fetch + scheduled handlers.
// The cron tick (configured in wrangler.toml [triggers]) sweeps any
// scheduled flyers whose scheduled_send_at has passed and publishes them.
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      runScheduledPublishes(env).then(
        (r) => console.log('[cron] scheduled-publish', r),
        (err) => console.error('[cron] scheduled-publish failed', err),
      ),
    );
  },
};
