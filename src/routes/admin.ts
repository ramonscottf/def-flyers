// Admin reviewer API.
// Auth: every route requires a session whose user has is_district_admin=1.
// (Microsoft Entra OIDC is a Phase 1.5 task — Bateman has to provision the
// app reg first. For MVP, the flag is flipped manually after Scott's first
// magic-link login.)
//
//   GET  /api/admin/queue                 pending flyers + AI verdicts
//   GET  /api/admin/flyer/:id             full record (incl. revisions/audits)
//   POST /api/admin/flyer/:id/approve     approve (or schedule)
//   POST /api/admin/flyer/:id/reject      reject + email submitter
//   POST /api/admin/flyer/:id/request     request changes + email submitter
//   GET  /api/admin/metrics               counts by status
//   GET  /api/admin/audit                 recent admin actions

import { Hono } from 'hono';
import type { Bindings } from '../index';
import { requireDistrictAdmin, type AppVariables } from '../auth/session';
import { getTransactionalSender } from '../lib/email';
import {
  renderApprovalEmail,
  renderRejectEmail,
  renderRequestChangesEmail,
} from '../email/templates/reviewerNotice';

const api = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

api.use('*', requireDistrictAdmin());

const REVIEWABLE_STATUSES = ['submitted', 'ai_review', 'reviewer'] as const;

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined;
}

interface FlyerWithMeta {
  id: string;
  slug: string;
  title: string;
  summary: string;
  audience: string;
  scope: string;
  category: string;
  status: string;
  expires_at: number;
  submitted_at: number;
  submitted_by: string;
  submitter_email: string | null;
  reading_level: number | null;
  word_count: number | null;
  ai_verdict_json: string | null;
  prompt_version: string | null;
  ai_processed_at: number | null;
  pdf_r2_key: string | null;
  image_r2_key: string | null;
  body_html: string;
  body_plain: string;
  body_html_es: string | null;
  title_es: string | null;
  summary_es: string | null;
  image_alt_text: string | null;
  event_start_at: number | null;
  event_end_at: number | null;
  event_location: string | null;
  rejected_reason: string | null;
  approved_at: number | null;
  approved_by: string | null;
  scheduled_send_at: number | null;
  version: number;
  updated_at: number;
}

async function loadFlyer(env: Bindings, id: string): Promise<FlyerWithMeta | null> {
  const row = await env.DB.prepare(
    `SELECT f.*, u.email AS submitter_email, NULL AS scheduled_send_at
     FROM flyers f
     LEFT JOIN users u ON u.id = f.submitted_by
     WHERE f.id = ?`,
  )
    .bind(id)
    .first<FlyerWithMeta>();
  return row ?? null;
}

async function logAudit(
  env: Bindings,
  userId: string,
  action: string,
  flyerId: string,
  before: unknown,
  after: unknown,
  ip?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO admin_audit_log
       (user_id, action, target_type, target_id, before_state, after_state, ip_address, created_at)
     VALUES (?, ?, 'flyer', ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      action,
      flyerId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      ip ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

async function snapshotRevision(
  env: Bindings,
  flyer: FlyerWithMeta,
  changedBy: string,
  changeNote: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO flyer_revisions (flyer_id, version, snapshot, changed_by, changed_at, change_note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(flyer.id, flyer.version, JSON.stringify(flyer), changedBy, Math.floor(Date.now() / 1000), changeNote)
    .run();
}

// ─── GET /api/admin/queue ──────────────────────────────────────────────────
api.get('/queue', async (c) => {
  const placeholders = REVIEWABLE_STATUSES.map(() => '?').join(',');
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.slug, f.title, f.audience, f.scope, f.category, f.status,
            f.submitted_at, f.expires_at, f.reading_level, f.word_count,
            f.ai_verdict_json, f.ai_processed_at,
            f.pdf_r2_key, f.image_r2_key,
            u.email AS submitter_email
     FROM flyers f
     LEFT JOIN users u ON u.id = f.submitted_by
     WHERE f.status IN (${placeholders})
     ORDER BY f.submitted_at ASC
     LIMIT 200`,
  )
    .bind(...REVIEWABLE_STATUSES)
    .all();
  return c.json({ flyers: results, count: results.length });
});

// ─── GET /api/admin/metrics ────────────────────────────────────────────────
api.get('/metrics', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM flyers GROUP BY status ORDER BY status`,
  ).all<{ status: string; n: number }>();
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = r.n;
  return c.json({ counts });
});

// ─── GET /api/admin/audit ──────────────────────────────────────────────────
api.get('/audit', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.user_id, a.action, a.target_type, a.target_id,
            a.before_state, a.after_state, a.ip_address, a.created_at,
            u.email AS actor_email
     FROM admin_audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  return c.json({ entries: results, count: results.length });
});

// ─── GET /api/admin/flyer/:id ──────────────────────────────────────────────
api.get('/flyer/:id', async (c) => {
  const id = c.req.param('id');
  const row = await loadFlyer(c.env, id);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const [schools, departments, revisions, audits] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.id, s.name, s.short_name, s.level
       FROM flyer_schools fs JOIN schools s ON s.id = fs.school_id
       WHERE fs.flyer_id = ?`,
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      `SELECT d.id, d.name FROM flyer_departments fd
       JOIN departments d ON d.id = fd.department_id
       WHERE fd.flyer_id = ?`,
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      `SELECT id, version, changed_by, changed_at, change_note
       FROM flyer_revisions WHERE flyer_id = ? ORDER BY changed_at DESC LIMIT 50`,
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      `SELECT id, audit_type, score, passed, findings, audited_at, audited_version
       FROM accessibility_audits WHERE flyer_id = ? ORDER BY audited_at DESC LIMIT 20`,
    )
      .bind(id)
      .all(),
  ]);

  return c.json({
    flyer: row,
    schools: schools.results,
    departments: departments.results,
    revisions: revisions.results,
    audits: audits.results,
  });
});

// ─── POST /api/admin/flyer/:id/approve ─────────────────────────────────────
api.post('/flyer/:id/approve', async (c) => {
  const reviewer = c.get('user');
  const id = c.req.param('id');
  let body: { scheduled_send_at?: unknown } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }

  const flyer = await loadFlyer(c.env, id);
  if (!flyer) return c.json({ error: 'not_found' }, 404);
  if (!REVIEWABLE_STATUSES.includes(flyer.status as (typeof REVIEWABLE_STATUSES)[number])) {
    return c.json({ error: 'wrong_status', message: `flyer is ${flyer.status}` }, 409);
  }

  let scheduledSendAt: number | null = null;
  if (body.scheduled_send_at !== undefined && body.scheduled_send_at !== null) {
    if (typeof body.scheduled_send_at !== 'number' || !Number.isFinite(body.scheduled_send_at)) {
      return c.json({ error: 'invalid_scheduled_send_at' }, 400);
    }
    scheduledSendAt =
      body.scheduled_send_at > 1e12
        ? Math.floor(body.scheduled_send_at / 1000)
        : Math.floor(body.scheduled_send_at);
    if (scheduledSendAt <= Math.floor(Date.now() / 1000)) {
      return c.json({ error: 'scheduled_send_at_in_past' }, 400);
    }
  }

  const newStatus = scheduledSendAt ? 'scheduled' : 'approved';
  const now = Math.floor(Date.now() / 1000);

  await snapshotRevision(c.env, flyer, reviewer.id, scheduledSendAt ? 'scheduled' : 'approved');

  await c.env.DB.prepare(
    `UPDATE flyers
     SET status = ?, approved_by = ?, approved_at = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  )
    .bind(newStatus, reviewer.id, now, now, id)
    .run();

  await logAudit(
    c.env,
    reviewer.id,
    'flyer.approve',
    id,
    { status: flyer.status },
    { status: newStatus, scheduled_send_at: scheduledSendAt },
    clientIp(c),
  );

  // Notify submitter (best-effort).
  if (flyer.submitter_email) {
    try {
      const sender = getTransactionalSender(c.env);
      const { subject, html, text } = renderApprovalEmail({
        flyerTitle: flyer.title,
        scheduled: !!scheduledSendAt,
        scheduledFor: scheduledSendAt ?? undefined,
      });
      c.executionCtx.waitUntil(
        sender
          .send({ to: flyer.submitter_email, subject, html, text, tag: 'flyer-approved' })
          .catch((err) => console.error('[admin/approve] email failed', err)),
      );
    } catch (err) {
      console.error('[admin/approve] email setup failed', err);
    }
  }

  return c.json({ flyer_id: id, status: newStatus, scheduled_send_at: scheduledSendAt });
});

// ─── POST /api/admin/flyer/:id/reject ──────────────────────────────────────
api.post('/flyer/:id/reject', async (c) => {
  const reviewer = c.get('user');
  const id = c.req.param('id');

  let body: { reason?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 1000) return c.json({ error: 'invalid_reason' }, 400);

  const flyer = await loadFlyer(c.env, id);
  if (!flyer) return c.json({ error: 'not_found' }, 404);
  if (!REVIEWABLE_STATUSES.includes(flyer.status as (typeof REVIEWABLE_STATUSES)[number])) {
    return c.json({ error: 'wrong_status', message: `flyer is ${flyer.status}` }, 409);
  }

  const now = Math.floor(Date.now() / 1000);

  await snapshotRevision(c.env, flyer, reviewer.id, `rejected: ${reason.slice(0, 200)}`);

  await c.env.DB.prepare(
    `UPDATE flyers
     SET status = 'rejected', rejected_reason = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  )
    .bind(reason, now, id)
    .run();

  await logAudit(
    c.env,
    reviewer.id,
    'flyer.reject',
    id,
    { status: flyer.status },
    { status: 'rejected', reason },
    clientIp(c),
  );

  if (flyer.submitter_email) {
    try {
      const sender = getTransactionalSender(c.env);
      const { subject, html, text } = renderRejectEmail({
        flyerTitle: flyer.title,
        reason,
        baseUrl: c.env.PUBLIC_BASE_URL,
      });
      c.executionCtx.waitUntil(
        sender
          .send({ to: flyer.submitter_email, subject, html, text, tag: 'flyer-rejected' })
          .catch((err) => console.error('[admin/reject] email failed', err)),
      );
    } catch (err) {
      console.error('[admin/reject] email setup failed', err);
    }
  }

  return c.json({ flyer_id: id, status: 'rejected' });
});

// ─── POST /api/admin/flyer/:id/request ─────────────────────────────────────
api.post('/flyer/:id/request', async (c) => {
  const reviewer = c.get('user');
  const id = c.req.param('id');

  let body: { notes?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (!notes || notes.length > 2000) return c.json({ error: 'invalid_notes' }, 400);

  const flyer = await loadFlyer(c.env, id);
  if (!flyer) return c.json({ error: 'not_found' }, 404);
  if (!REVIEWABLE_STATUSES.includes(flyer.status as (typeof REVIEWABLE_STATUSES)[number])) {
    return c.json({ error: 'wrong_status', message: `flyer is ${flyer.status}` }, 409);
  }

  const now = Math.floor(Date.now() / 1000);

  await snapshotRevision(c.env, flyer, reviewer.id, `request_changes: ${notes.slice(0, 200)}`);

  await c.env.DB.prepare(
    `UPDATE flyers
     SET status = 'draft', updated_at = ?, version = version + 1
     WHERE id = ?`,
  )
    .bind(now, id)
    .run();

  await logAudit(
    c.env,
    reviewer.id,
    'flyer.request_changes',
    id,
    { status: flyer.status },
    { status: 'draft', notes },
    clientIp(c),
  );

  if (flyer.submitter_email) {
    try {
      const sender = getTransactionalSender(c.env);
      const { subject, html, text } = renderRequestChangesEmail({
        flyerTitle: flyer.title,
        notes,
        baseUrl: c.env.PUBLIC_BASE_URL,
        flyerId: id,
      });
      c.executionCtx.waitUntil(
        sender
          .send({ to: flyer.submitter_email, subject, html, text, tag: 'flyer-changes-requested' })
          .catch((err) => console.error('[admin/request] email failed', err)),
      );
    } catch (err) {
      console.error('[admin/request] email setup failed', err);
    }
  }

  return c.json({ flyer_id: id, status: 'draft' });
});

export default api;
