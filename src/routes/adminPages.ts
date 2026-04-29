// Server-rendered admin reviewer UI.
// All routes here require an authenticated session whose user has
// is_district_admin=1.
//
//   GET  /admin                          queue
//   GET  /admin/flyer/:id                detail + action forms
//   POST /admin/flyer/:id/approve        approve (form)
//   POST /admin/flyer/:id/reject         reject (form)
//   POST /admin/flyer/:id/request        request changes (form)
//   GET  /admin/r2/:key+                 inline R2 object preview (gated)
//
// All POSTs redirect back to /admin (or /admin/flyer/:id on validation failure)
// — works without JS.

import { Hono } from 'hono';
import type { Bindings } from '../index';
import { getCookie } from 'hono/cookie';
import {
  SESSION_COOKIE,
  loadSession,
  type AppVariables,
} from '../auth/session';
import { getTransactionalSender } from '../lib/email';
import {
  renderApprovalEmail,
  renderRejectEmail,
  renderRequestChangesEmail,
} from '../email/templates/reviewerNotice';
import { publishFlyer } from '../publish';

const pages = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

const REVIEWABLE_STATUSES = ['submitted', 'ai_review', 'reviewer'] as const;

// Inline middleware: require district admin, but render an HTML "denied"
// page rather than a JSON 401/403 since this surface is meant for humans.
pages.use('*', async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return c.html(loginPrompt(), 401);
  const user = await loadSession(c.env, sid);
  if (!user) return c.html(loginPrompt(), 401);
  if (!user.is_district_admin) return c.html(forbiddenPage(user.email), 403);
  c.set('user', user);
  c.set('sessionId', sid);
  await next();
});

function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(unixSeconds: number | null | undefined, tz = 'America/Denver'): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleString('en-US', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function fmtRelative(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '—';
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shell(opts: {
  title: string;
  user: { email: string };
  body: string;
  flash?: { kind: 'success' | 'error'; message: string };
}) {
  const flash = opts.flash
    ? `<div class="flash flash-${opts.flash.kind}" role="status">${escapeHtml(opts.flash.message)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)} · DEF Flyers admin</title>
<meta name="robots" content="noindex">
<style>
  :root {
    --navy:#0d1b3d; --navy-2:#1a2a5e; --gold:#c9a13b; --red:#b1252f;
    --bg:#fff; --card:#f3f5f9; --ink:#0d1b3d; --ink-2:#4a5876; --rule:#d8dde7;
    --green:#1f7a3f; --yellow:#a87b00; --redbg:#fbeaea;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    color:var(--ink);background:var(--bg);line-height:1.5}
  a{color:var(--navy-2)}a:hover{color:var(--red)}
  .skip-link{position:absolute;top:-40px;left:0;background:var(--navy);color:#fff;padding:8px 16px;z-index:100}
  .skip-link:focus{top:0}
  header.bar{background:var(--navy);color:#fff;padding:14px 24px;
    border-bottom:4px solid;border-image:linear-gradient(90deg,var(--navy-2),var(--red)) 1}
  header.bar .inner{max-width:1100px;margin:0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
  header.bar h1{margin:0;font-size:18px;font-weight:800}
  header.bar a{color:#d6dcec}
  header.bar nav{font-size:13px;display:flex;gap:16px}
  main{max-width:1100px;margin:24px auto;padding:0 24px 64px}
  h2{font-size:22px;margin:0 0 12px;color:var(--navy)}
  h3{font-size:17px;margin:24px 0 8px;color:var(--navy)}
  .flash{padding:12px 16px;border-radius:8px;margin:0 0 16px;font-size:14px}
  .flash-success{background:#e6f4ea;border:1px solid #9bcdab;color:#1f4d2c}
  .flash-error{background:var(--redbg);border:1px solid #e3a8ad;color:#6b1c22}
  table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
  th{background:var(--card);font-weight:600;color:var(--navy);font-size:13px;text-transform:uppercase;letter-spacing:0.04em}
  tr:hover td{background:#fafbfd}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:0.02em}
  .badge-status-submitted,.badge-status-ai_review{background:#eef1fa;color:var(--navy-2)}
  .badge-status-reviewer{background:#fff8e1;color:var(--yellow)}
  .badge-status-approved,.badge-status-scheduled{background:#e6f4ea;color:var(--green)}
  .badge-status-rejected{background:var(--redbg);color:var(--red)}
  .badge-status-draft{background:var(--card);color:var(--ink-2)}
  .badge-verdict-green{background:#e6f4ea;color:var(--green)}
  .badge-verdict-yellow{background:#fff8e1;color:var(--yellow)}
  .badge-verdict-red{background:var(--redbg);color:var(--red)}
  .grid-2{display:grid;grid-template-columns:1fr 320px;gap:24px}
  @media (max-width:900px){.grid-2{grid-template-columns:1fr}}
  .card{background:var(--card);border-radius:10px;padding:18px}
  .card h3:first-child{margin-top:0}
  pre{white-space:pre-wrap;word-wrap:break-word;font-size:12px;background:#fff;padding:10px;border-radius:6px;border:1px solid var(--rule);max-height:280px;overflow:auto}
  .actions form{margin:0 0 12px;background:#fff;border:1px solid var(--rule);border-radius:8px;padding:14px}
  .actions textarea,.actions input[type=text],.actions input[type=datetime-local]{
    width:100%;padding:8px 10px;border:1px solid var(--rule);border-radius:6px;font-family:inherit;font-size:14px;
  }
  .actions textarea{min-height:72px;resize:vertical}
  .actions button{margin-top:8px;background:var(--navy);color:#fff;border:none;padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px}
  .actions button:hover{background:var(--red)}
  .actions .danger button{background:var(--red)}
  .actions .danger button:hover{background:#7c1820}
  dl.kv{display:grid;grid-template-columns:140px 1fr;gap:8px 16px;margin:0;font-size:14px}
  dl.kv dt{color:var(--ink-2);font-weight:600}
  dl.kv dd{margin:0}
  .preview-frame{width:100%;border:1px solid var(--rule);border-radius:6px;background:#fff}
  .empty{padding:48px 16px;text-align:center;color:var(--ink-2);background:var(--card);border-radius:10px}
  footer{border-top:1px solid var(--rule);padding:16px 24px;text-align:center;color:var(--ink-2);font-size:12px}
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="bar">
  <div class="inner">
    <h1><a href="/admin" style="color:#fff;text-decoration:none;">DEF Flyers — admin</a></h1>
    <nav>
      <a href="/admin">Queue</a>
      <span style="color:#a8b3cd;">${escapeHtml(opts.user.email)}</span>
    </nav>
  </div>
</header>
<main id="main">
  ${flash}
  ${opts.body}
</main>
<footer>Davis Education Foundation · admin reviewer</footer>
</body>
</html>`;
}

function loginPrompt(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Sign in required</title>
<style>body{font-family:system-ui;margin:60px auto;max-width:480px;padding:0 24px;color:#0d1b3d}
a{color:#1a2a5e}.btn{display:inline-block;background:#0d1b3d;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600}</style>
</head><body>
<h1>Sign in required</h1>
<p>This area is for DEF reviewers. Please sign in via magic link.</p>
<p><a class="btn" href="/submit">Go to sign-in</a></p>
</body></html>`;
}

function forbiddenPage(email: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not authorised</title>
<style>body{font-family:system-ui;margin:60px auto;max-width:480px;padding:0 24px;color:#0d1b3d}</style>
</head><body>
<h1>Not authorised</h1>
<p>You're signed in as <strong>${escapeHtml(email)}</strong>, but this account does not have reviewer access.</p>
<p>If you should have access, ask Scott to flip <code>is_district_admin = 1</code> on your <code>users</code> row.</p>
</body></html>`;
}

interface QueueRow {
  id: string;
  slug: string;
  title: string;
  audience: string;
  scope: string;
  category: string;
  status: string;
  submitted_at: number;
  expires_at: number;
  reading_level: number | null;
  word_count: number | null;
  ai_verdict_json: string | null;
  ai_processed_at: number | null;
  pdf_r2_key: string | null;
  image_r2_key: string | null;
  submitter_email: string | null;
}

function verdictFromJson(json: string | null): { verdict?: string; flags?: string[] } {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    const m = v?.steps?.moderation;
    return { verdict: m?.verdict, flags: m?.flags };
  } catch {
    return {};
  }
}

// ─── GET /admin ────────────────────────────────────────────────────────────
pages.get('/', async (c) => {
  const user = c.get('user');
  const flash = readFlash(c);
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
    .all<QueueRow>();

  const counts = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM flyers GROUP BY status`,
  ).all<{ status: string; n: number }>();

  const countMap: Record<string, number> = {};
  for (const r of counts.results) countMap[r.status] = r.n;

  const rows = results
    .map((r) => {
      const v = verdictFromJson(r.ai_verdict_json);
      const verdictBadge = v.verdict
        ? `<span class="badge badge-verdict-${v.verdict}">${escapeHtml(v.verdict)}</span>`
        : '<span class="badge" style="background:#eef1fa;color:#4a5876;">pending</span>';
      const flags = v.flags && v.flags.length > 0 ? ` <span style="color:#a87b00;font-size:12px;">⚑ ${escapeHtml(v.flags.join(', '))}</span>` : '';
      const artifactBits = [
        r.pdf_r2_key ? '📄 PDF' : null,
        r.image_r2_key ? '🖼️ image' : null,
      ].filter(Boolean).join(' · ');
      return `<tr>
        <td>
          <a href="/admin/flyer/${escapeHtml(r.id)}" style="font-weight:600;">${escapeHtml(r.title)}</a>
          <div style="font-size:12px;color:#4a5876;">${escapeHtml(r.submitter_email)} · ${escapeHtml(r.scope)}/${escapeHtml(r.audience)} · ${escapeHtml(r.category)}</div>
          ${artifactBits ? `<div style="font-size:12px;color:#4a5876;">${artifactBits}</div>` : ''}
        </td>
        <td><span class="badge badge-status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${verdictBadge}${flags}</td>
        <td>${fmtRelative(r.submitted_at)}</td>
        <td>${r.reading_level !== null ? r.reading_level.toFixed(1) : '—'}</td>
        <td>${fmtTime(r.expires_at)}</td>
      </tr>`;
    })
    .join('');

  const body = results.length > 0
    ? `<h2>Reviewer queue (${results.length})</h2>
       <table>
         <thead><tr>
           <th>Flyer</th>
           <th>Status</th>
           <th>AI verdict</th>
           <th>Submitted</th>
           <th>Grade</th>
           <th>Expires</th>
         </tr></thead>
         <tbody>${rows}</tbody>
       </table>
       <p style="margin-top:24px;color:#4a5876;font-size:13px;">
         Total: ${Object.entries(countMap).map(([k, v]) => `${escapeHtml(k)}=${v}`).join(' · ') || '0'}
       </p>`
    : `<h2>Reviewer queue</h2><div class="empty">No flyers awaiting review.</div>`;

  return c.html(shell({ title: 'Queue', user, body, flash }));
});

interface FlyerDetailRow {
  id: string;
  slug: string;
  title: string;
  title_es: string | null;
  summary: string;
  summary_es: string | null;
  body_html: string;
  body_html_es: string | null;
  body_plain: string;
  reading_level: number | null;
  word_count: number | null;
  audience: string;
  scope: string;
  category: string;
  tags: string | null;
  status: string;
  expires_at: number;
  event_start_at: number | null;
  event_end_at: number | null;
  event_location: string | null;
  pdf_r2_key: string | null;
  image_r2_key: string | null;
  image_alt_text: string | null;
  submitter_email: string | null;
  submitted_by: string;
  submitted_at: number;
  ai_verdict_json: string | null;
  prompt_version: string | null;
  ai_processed_at: number | null;
  rejected_reason: string | null;
  approved_at: number | null;
  approved_by: string | null;
  version: number;
}

// ─── GET /admin/flyer/:id ──────────────────────────────────────────────────
pages.get('/flyer/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const flash = readFlash(c);

  const flyer = await c.env.DB.prepare(
    `SELECT f.*, u.email AS submitter_email
     FROM flyers f LEFT JOIN users u ON u.id = f.submitted_by
     WHERE f.id = ?`,
  )
    .bind(id)
    .first<FlyerDetailRow>();
  if (!flyer) return c.html(shell({ title: 'Not found', user, body: '<h2>Not found</h2>' }), 404);

  const [schools, departments, audits, revisions] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.id, s.name, s.short_name FROM flyer_schools fs JOIN schools s ON s.id = fs.school_id WHERE fs.flyer_id = ?`,
    ).bind(id).all<{ id: string; name: string; short_name: string | null }>(),
    c.env.DB.prepare(
      `SELECT d.id, d.name FROM flyer_departments fd JOIN departments d ON d.id = fd.department_id WHERE fd.flyer_id = ?`,
    ).bind(id).all<{ id: string; name: string }>(),
    c.env.DB.prepare(
      `SELECT id, audit_type, score, passed, findings, audited_at FROM accessibility_audits WHERE flyer_id = ? ORDER BY audited_at DESC LIMIT 5`,
    ).bind(id).all<{ id: number; audit_type: string; score: number; passed: number; findings: string; audited_at: number }>(),
    c.env.DB.prepare(
      `SELECT id, version, change_note, changed_at FROM flyer_revisions WHERE flyer_id = ? ORDER BY changed_at DESC LIMIT 10`,
    ).bind(id).all<{ id: number; version: number; change_note: string; changed_at: number }>(),
  ]);

  const reviewable = REVIEWABLE_STATUSES.includes(flyer.status as (typeof REVIEWABLE_STATUSES)[number]);
  const verdict = verdictFromJson(flyer.ai_verdict_json);
  const verdictBadge = verdict.verdict
    ? `<span class="badge badge-verdict-${verdict.verdict}">${escapeHtml(verdict.verdict)}</span>`
    : '<span class="badge" style="background:#eef1fa;color:#4a5876;">pending</span>';

  const targets = flyer.scope === 'school'
    ? schools.results.map((s) => escapeHtml(s.name)).join(', ') || '—'
    : flyer.scope === 'department'
      ? departments.results.map((d) => escapeHtml(d.name)).join(', ') || '—'
      : 'District-wide';

  const auditPreview = audits.results.length > 0
    ? `<pre>${escapeHtml(JSON.stringify(audits.results.map((a) => ({...a, findings: safeParse(a.findings)})), null, 2))}</pre>`
    : '<p style="color:#4a5876;font-size:13px;">No accessibility audits yet.</p>';

  const verdictPreview = flyer.ai_verdict_json
    ? `<pre>${escapeHtml(JSON.stringify(safeParse(flyer.ai_verdict_json), null, 2))}</pre>`
    : '<p style="color:#4a5876;font-size:13px;">AI verdict not yet recorded.</p>';

  const artifactPreview = [
    flyer.image_r2_key ? `<p>🖼️ <a href="/admin/r2?k=${encodeURIComponent(flyer.image_r2_key)}" target="_blank" rel="noreferrer">${escapeHtml(flyer.image_r2_key)}</a></p>` : '',
    flyer.pdf_r2_key ? `<p>📄 <a href="/admin/r2?k=${encodeURIComponent(flyer.pdf_r2_key)}" target="_blank" rel="noreferrer">${escapeHtml(flyer.pdf_r2_key)}</a></p>` : '',
  ].join('') || '<p style="color:#4a5876;font-size:13px;">No uploaded artefacts.</p>';

  const revisionList = revisions.results.length > 0
    ? `<ul style="margin:0;padding-left:18px;font-size:13px;color:#4a5876;">${revisions.results.map((r) => `<li>v${r.version} — ${escapeHtml(r.change_note ?? '')} (${fmtRelative(r.changed_at)})</li>`).join('')}</ul>`
    : '<p style="color:#4a5876;font-size:13px;">No revisions yet.</p>';

  const actions = reviewable
    ? `<div class="actions">
        <h3>Approve</h3>
        <form method="POST" action="/admin/flyer/${escapeHtml(id)}/approve">
          <label style="font-size:13px;color:#4a5876;display:block;margin-bottom:6px;">Optional schedule (Mountain Time)</label>
          <input type="datetime-local" name="scheduled_send_at" value="">
          <button type="submit">Approve</button>
        </form>
        <h3>Request changes</h3>
        <form method="POST" action="/admin/flyer/${escapeHtml(id)}/request">
          <label style="font-size:13px;color:#4a5876;display:block;margin-bottom:6px;">Notes for the submitter</label>
          <textarea name="notes" required maxlength="2000" placeholder="What needs to change?"></textarea>
          <button type="submit">Request changes</button>
        </form>
        <h3>Reject</h3>
        <form method="POST" action="/admin/flyer/${escapeHtml(id)}/reject" class="danger">
          <label style="font-size:13px;color:#4a5876;display:block;margin-bottom:6px;">Reason (sent to submitter)</label>
          <textarea name="reason" required maxlength="1000" placeholder="Why is this being rejected?"></textarea>
          <button type="submit">Reject</button>
        </form>
      </div>`
    : `<div class="card"><p>Flyer is in <strong>${escapeHtml(flyer.status)}</strong> state — no reviewer actions available.</p></div>`;

  const body = `
    <p style="margin:0 0 12px;font-size:13px;"><a href="/admin">← Queue</a></p>
    <div class="grid-2">
      <section>
        <h2>${escapeHtml(flyer.title)}</h2>
        <p style="color:#4a5876;margin:0 0 16px;">${escapeHtml(flyer.summary)}</p>
        <dl class="kv">
          <dt>Status</dt><dd><span class="badge badge-status-${escapeHtml(flyer.status)}">${escapeHtml(flyer.status)}</span> · v${flyer.version}</dd>
          <dt>Submitter</dt><dd>${escapeHtml(flyer.submitter_email ?? '—')}</dd>
          <dt>Audience / scope</dt><dd>${escapeHtml(flyer.audience)} / ${escapeHtml(flyer.scope)}</dd>
          <dt>Targets</dt><dd>${targets}</dd>
          <dt>Category</dt><dd>${escapeHtml(flyer.category)}</dd>
          <dt>Submitted</dt><dd>${fmtTime(flyer.submitted_at)} (${fmtRelative(flyer.submitted_at)})</dd>
          <dt>Expires</dt><dd>${fmtTime(flyer.expires_at)}</dd>
          ${flyer.event_start_at ? `<dt>Event</dt><dd>${fmtTime(flyer.event_start_at)}${flyer.event_end_at ? ' → ' + fmtTime(flyer.event_end_at) : ''}${flyer.event_location ? ' · ' + escapeHtml(flyer.event_location) : ''}</dd>` : ''}
          <dt>Reading grade</dt><dd>${flyer.reading_level !== null ? flyer.reading_level.toFixed(1) : '—'} · ${flyer.word_count ?? 0} words</dd>
          <dt>AI verdict</dt><dd>${verdictBadge} · prompt ${escapeHtml(flyer.prompt_version ?? '—')} · processed ${fmtRelative(flyer.ai_processed_at)}</dd>
          ${flyer.rejected_reason ? `<dt>Rejected</dt><dd style="color:#6b1c22;">${escapeHtml(flyer.rejected_reason)}</dd>` : ''}
        </dl>

        <h3>English body</h3>
        <div class="card" style="background:#fff;border:1px solid var(--rule);">${flyer.body_html || '<p style="color:#4a5876;">(empty)</p>'}</div>

        ${flyer.body_html_es ? `<h3>Spanish body</h3>
        <div class="card" style="background:#fff;border:1px solid var(--rule);">${flyer.body_html_es}</div>` : ''}

        <h3>Uploaded artefacts</h3>
        ${artifactPreview}

        <h3>AI verdict (raw)</h3>
        ${verdictPreview}

        <h3>Accessibility audits</h3>
        ${auditPreview}

        <h3>Revision history</h3>
        ${revisionList}
      </section>

      <aside>
        ${actions}
      </aside>
    </div>
  `;

  return c.html(shell({ title: flyer.title, user, body, flash }));
});

function safeParse(s: string | null | undefined): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// ─── shared helpers for action POSTs ───────────────────────────────────────
async function snapshotRevision(
  env: Bindings,
  flyer: { id: string; version: number },
  changedBy: string,
  note: string,
  full: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO flyer_revisions (flyer_id, version, snapshot, changed_by, changed_at, change_note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(flyer.id, flyer.version, JSON.stringify(full), changedBy, Math.floor(Date.now() / 1000), note)
    .run();
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

function setFlash(
  c: { header: (n: string, v: string) => void },
  kind: 'success' | 'error',
  message: string,
): void {
  // Cookie-based flash. URL-encoded; small enough to fit easily.
  const value = encodeURIComponent(`${kind}|${message}`);
  c.header(
    'Set-Cookie',
    `def_flash=${value}; Path=/; Max-Age=30; HttpOnly; SameSite=Lax; Secure`,
  );
}

function readFlash(
  c: { req: { header: (n: string) => string | undefined }; header: (n: string, v: string) => void },
): { kind: 'success' | 'error'; message: string } | undefined {
  const cookie = c.req.header('cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)def_flash=([^;]+)/);
  if (!m) return undefined;
  c.header('Set-Cookie', `def_flash=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
  try {
    const decoded = decodeURIComponent(m[1]);
    const sep = decoded.indexOf('|');
    if (sep < 0) return undefined;
    const kind = decoded.slice(0, sep);
    const message = decoded.slice(sep + 1);
    if (kind !== 'success' && kind !== 'error') return undefined;
    return { kind, message };
  } catch {
    return undefined;
  }
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined;
}

interface ActionFlyerRow {
  id: string;
  title: string;
  status: string;
  version: number;
  submitter_email: string | null;
}

async function loadActionFlyer(
  env: Bindings,
  id: string,
): Promise<ActionFlyerRow | null> {
  return await env.DB.prepare(
    `SELECT f.id, f.title, f.status, f.version, u.email AS submitter_email
     FROM flyers f LEFT JOIN users u ON u.id = f.submitted_by
     WHERE f.id = ?`,
  )
    .bind(id)
    .first<ActionFlyerRow>();
}

// ─── POST /admin/flyer/:id/approve ─────────────────────────────────────────
pages.post('/flyer/:id/approve', async (c) => {
  const reviewer = c.get('user');
  const id = c.req.param('id');

  const form = await c.req.parseBody();
  const scheduleRaw = typeof form.scheduled_send_at === 'string' ? form.scheduled_send_at.trim() : '';
  let scheduledSendAt: number | null = null;
  if (scheduleRaw) {
    const parsed = parseLocalDateTime(scheduleRaw);
    if (parsed === null) {
      setFlash(c, 'error', 'Could not parse schedule time. Use the date-time picker.');
      return c.redirect(`/admin/flyer/${id}`, 303);
    }
    if (parsed <= Math.floor(Date.now() / 1000)) {
      setFlash(c, 'error', 'Scheduled time must be in the future.');
      return c.redirect(`/admin/flyer/${id}`, 303);
    }
    scheduledSendAt = parsed;
  }

  const flyer = await loadActionFlyer(c.env, id);
  if (!flyer) {
    setFlash(c, 'error', 'Flyer not found.');
    return c.redirect('/admin', 303);
  }
  if (!REVIEWABLE_STATUSES.includes(flyer.status as (typeof REVIEWABLE_STATUSES)[number])) {
    setFlash(c, 'error', `Flyer is in "${flyer.status}" — cannot approve.`);
    return c.redirect(`/admin/flyer/${id}`, 303);
  }

  const newStatus = scheduledSendAt ? 'scheduled' : 'approved';
  const now = Math.floor(Date.now() / 1000);

  await snapshotRevision(c.env, flyer, reviewer.id, scheduledSendAt ? 'scheduled' : 'approved', flyer);

  await c.env.DB.prepare(
    `UPDATE flyers
     SET status = ?, approved_by = ?, approved_at = ?, scheduled_send_at = ?,
         updated_at = ?, version = version + 1
     WHERE id = ?`,
  )
    .bind(newStatus, reviewer.id, now, scheduledSendAt, now, id)
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

  if (flyer.submitter_email) {
    try {
      const sender = getTransactionalSender(c.env);
      const { subject, html, text } = renderApprovalEmail({
        flyerTitle: flyer.title,
        scheduled: !!scheduledSendAt,
        scheduledFor: scheduledSendAt ?? undefined,
      });
      c.executionCtx.waitUntil(
        sender.send({ to: flyer.submitter_email, subject, html, text, tag: 'flyer-approved' }).catch((err) => {
          console.error('[admin/approve] email failed', err);
        }),
      );
    } catch (err) {
      console.error('[admin/approve] email setup failed', err);
    }
  }

  if (!scheduledSendAt) {
    c.executionCtx.waitUntil(
      publishFlyer(c.env, id, c.executionCtx).then(
        (r) => {
          if (!r.ok) console.error('[admin/approve] publish failed', id, r.reason);
        },
        (err) => console.error('[admin/approve] publish error', id, err),
      ),
    );
  }

  setFlash(c, 'success', scheduledSendAt
    ? `"${flyer.title}" scheduled.`
    : `"${flyer.title}" approved.`);
  return c.redirect('/admin', 303);
});

// ─── POST /admin/flyer/:id/reject ──────────────────────────────────────────
pages.post('/flyer/:id/reject', async (c) => {
  const reviewer = c.get('user');
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  const reason = typeof form.reason === 'string' ? form.reason.trim() : '';
  if (!reason || reason.length > 1000) {
    setFlash(c, 'error', 'Reject reason is required.');
    return c.redirect(`/admin/flyer/${id}`, 303);
  }

  const flyer = await loadActionFlyer(c.env, id);
  if (!flyer) {
    setFlash(c, 'error', 'Flyer not found.');
    return c.redirect('/admin', 303);
  }
  if (!REVIEWABLE_STATUSES.includes(flyer.status as (typeof REVIEWABLE_STATUSES)[number])) {
    setFlash(c, 'error', `Flyer is in "${flyer.status}" — cannot reject.`);
    return c.redirect(`/admin/flyer/${id}`, 303);
  }

  const now = Math.floor(Date.now() / 1000);
  await snapshotRevision(c.env, flyer, reviewer.id, `rejected: ${reason.slice(0, 200)}`, flyer);
  await c.env.DB.prepare(
    `UPDATE flyers
     SET status = 'rejected', rejected_reason = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).bind(reason, now, id).run();

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
        sender.send({ to: flyer.submitter_email, subject, html, text, tag: 'flyer-rejected' }).catch((err) => {
          console.error('[admin/reject] email failed', err);
        }),
      );
    } catch (err) {
      console.error('[admin/reject] email setup failed', err);
    }
  }

  setFlash(c, 'success', `"${flyer.title}" rejected. Submitter notified.`);
  return c.redirect('/admin', 303);
});

// ─── POST /admin/flyer/:id/request ─────────────────────────────────────────
pages.post('/flyer/:id/request', async (c) => {
  const reviewer = c.get('user');
  const id = c.req.param('id');
  const form = await c.req.parseBody();
  const notes = typeof form.notes === 'string' ? form.notes.trim() : '';
  if (!notes || notes.length > 2000) {
    setFlash(c, 'error', 'Notes for the submitter are required.');
    return c.redirect(`/admin/flyer/${id}`, 303);
  }

  const flyer = await loadActionFlyer(c.env, id);
  if (!flyer) {
    setFlash(c, 'error', 'Flyer not found.');
    return c.redirect('/admin', 303);
  }
  if (!REVIEWABLE_STATUSES.includes(flyer.status as (typeof REVIEWABLE_STATUSES)[number])) {
    setFlash(c, 'error', `Flyer is in "${flyer.status}" — cannot request changes.`);
    return c.redirect(`/admin/flyer/${id}`, 303);
  }

  const now = Math.floor(Date.now() / 1000);
  await snapshotRevision(c.env, flyer, reviewer.id, `request_changes: ${notes.slice(0, 200)}`, flyer);
  await c.env.DB.prepare(
    `UPDATE flyers SET status = 'draft', updated_at = ?, version = version + 1 WHERE id = ?`,
  ).bind(now, id).run();

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
        sender.send({ to: flyer.submitter_email, subject, html, text, tag: 'flyer-changes-requested' }).catch((err) => {
          console.error('[admin/request] email failed', err);
        }),
      );
    } catch (err) {
      console.error('[admin/request] email setup failed', err);
    }
  }

  setFlash(c, 'success', `Changes requested on "${flyer.title}". Returned to submitter.`);
  return c.redirect('/admin', 303);
});

// ─── GET /admin/r2 ─────────────────────────────────────────────────────────
// Inline preview of an uploaded R2 object. Gated by the admin middleware
// above; restricted to flyer artefacts (key must start with "flyers/").
pages.get('/r2', async (c) => {
  const key = c.req.query('k') ?? '';
  if (!key.startsWith('flyers/')) return c.text('forbidden', 403);
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.text('not found', 404);
  const headers = new Headers();
  headers.set('content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('cache-control', 'private, max-age=60');
  headers.set('content-disposition', 'inline');
  return new Response(obj.body, { headers });
});

// Local datetime-local input parsing → unix seconds (Mountain Time).
// datetime-local has no zone info — treat the string as Mountain time.
function parseLocalDateTime(s: string): number | null {
  // s looks like "2026-05-15T14:30"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [_, y, mo, d, h, mi, sec] = m;
  // Build the time as if it were UTC, then offset by 6 (MDT) or 7 (MST).
  // Use Intl to detect DST robustly: convert "wall-time → utc" via Intl.
  const wallMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0);
  const localOffsetMin = mountainOffsetMinutes(wallMs); // signed: -360 or -420
  return Math.floor((wallMs - localOffsetMin * 60_000) / 1000);
}

function mountainOffsetMinutes(utcMs: number): number {
  // Crude DST: 2nd Sunday in March → 1st Sunday in November is MDT (-360),
  // otherwise MST (-420). Good enough for scheduling.
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const dst = isUsDst(y, utcMs);
  return dst ? -360 : -420;
}

function isUsDst(year: number, utcMs: number): boolean {
  const marchSecondSunday = nthWeekday(year, 2, 0, 2); // March, Sunday, 2nd
  const novFirstSunday = nthWeekday(year, 10, 0, 1);
  const start = Date.UTC(year, 2, marchSecondSunday, 9); // 2 AM local ≈ 8-9 UTC
  const end = Date.UTC(year, 10, novFirstSunday, 9);
  return utcMs >= start && utcMs < end;
}

function nthWeekday(year: number, monthIndex: number, dayOfWeek: number, n: number): number {
  const first = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const offset = ((dayOfWeek - first + 7) % 7) + (n - 1) * 7;
  return 1 + offset;
}

export default pages;
