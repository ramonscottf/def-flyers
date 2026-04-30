// Server-rendered submitter UI for the §2.2 submission flow.
// Wraps the existing JSON helpers from submitterFlyers.ts so there's no
// duplicated business logic — only the form layer + HTML chrome lives here.
//
//   GET  /submit/flyers              list of own flyers
//   GET  /submit/new                 multi-section create form
//   POST /submit/new                 form-encoded create handler
//   GET  /submit/flyer/:id           detail + edit + upload + finalize
//   POST /submit/flyer/:id           form-encoded edit (draft only)
//   POST /submit/flyer/:id/upload    multipart upload (pdf|image)
//   POST /submit/flyer/:id/finalize  finalize button → AI pipeline
//
// Requires the same magic-link session middleware as the API. Flash messages
// piggyback on a short-lived def_flash cookie just like /admin pages.

import { Hono } from 'hono';
import type { Bindings } from '../index';
import { getCookie } from 'hono/cookie';
import {
  SESSION_COOKIE,
  loadSession,
  type AppVariables,
} from '../auth/session';
import { ulid } from '../lib/ulid';
import { slugWithSuffix } from '../lib/slug';
import { analyze } from '../lib/readability';
import { runAiPipeline } from '../ai/pipeline';
import {
  AUDIENCES,
  ALLOWED_CONTENT_TYPES,
  ALLOWED_UPLOAD_KINDS,
  EXT_BY_TYPE,
  MAX_UPLOAD_BYTES,
  SCOPES,
  asTrimmedString,
  asStringArray,
  loadFlyerForOwner,
  loadFlyerTargets,
  stripTags,
  validateScopeTargets,
  writeFlyerTargets,
  type FlyerRow,
} from './submitterFlyers';

const pages = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

// ─── Auth gate (HTML responses, not JSON) ──────────────────────────────────
// Scoped to /submit/* — this module is mounted at / so a bare `*` wildcard
// would match every request on the worker, including webhooks and the
// public flyer pages.
pages.use('/submit/*', async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return c.redirect('/submit', 303);
  const user = await loadSession(c.env, sid);
  if (!user) return c.redirect('/submit', 303);
  c.set('user', user);
  c.set('sessionId', sid);
  await next();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(unix: number | null | undefined, tz = 'America/Denver'): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('en-US', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function fmtRelative(unix: number | null | undefined): string {
  if (!unix) return '—';
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Render a Mountain-Time unix seconds back into a `<input type="datetime-local">` value.
function unixToLocalInput(unix: number | null | undefined): string {
  if (!unix) return '';
  // Use the en-CA locale because it conveniently produces YYYY-MM-DD,HH:mm:ss in MT,
  // then we pull out the parts we need.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(unix * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

// Parse `<input type="datetime-local">` value as Mountain Time → unix seconds.
function parseLocalDateTime(s: string): number | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const wallMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0);
  const offsetMin = mountainOffsetMinutes(wallMs);
  return Math.floor((wallMs - offsetMin * 60_000) / 1000);
}

function mountainOffsetMinutes(utcMs: number): number {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  return isUsDst(y, utcMs) ? -360 : -420;
}
function isUsDst(year: number, utcMs: number): boolean {
  const marchSecond = nthWeekday(year, 2, 0, 2);
  const novFirst = nthWeekday(year, 10, 0, 1);
  const start = Date.UTC(year, 2, marchSecond, 9);
  const end = Date.UTC(year, 10, novFirst, 9);
  return utcMs >= start && utcMs < end;
}
function nthWeekday(year: number, monthIndex: number, dayOfWeek: number, n: number): number {
  const first = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + (((dayOfWeek - first + 7) % 7) + (n - 1) * 7);
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined;
}

function setFlash(
  c: { header: (n: string, v: string) => void },
  kind: 'success' | 'error',
  message: string,
): void {
  const v = encodeURIComponent(`${kind}|${message}`);
  c.header('Set-Cookie', `def_flash=${v}; Path=/; Max-Age=30; HttpOnly; SameSite=Lax; Secure`);
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

// Treat a multi-checkbox form field as an array of strings.
function formFieldArray(
  form: Record<string, string | File | (string | File)[]>,
  name: string,
): string[] {
  const v = form[name];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return v ? [v] : [];
  return [];
}

function formFieldString(
  form: Record<string, string | File | (string | File)[]>,
  name: string,
): string {
  const v = form[name];
  if (typeof v === 'string') return v;
  return '';
}

// ─── Page chrome ───────────────────────────────────────────────────────────

const SHARED_CSS = `:root{--navy:#0d1b3d;--navy-2:#1a2a5e;--gold:#c9a13b;--red:#b1252f;--bg:#fff;--card:#f3f5f9;--ink:#0d1b3d;--ink-2:#4a5876;--rule:#d8dde7;--green:#1f7a3f;--yellow:#a87b00;--redbg:#fbeaea}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--bg);line-height:1.55}
a{color:var(--navy-2);text-underline-offset:2px}a:hover,a:focus{color:var(--red)}
.skip-link{position:absolute;top:-40px;left:0;background:var(--navy);color:#fff;padding:8px 16px;z-index:100}
.skip-link:focus{top:0}
header.bar{background:var(--navy);color:#fff;padding:14px 24px;border-bottom:4px solid;border-image:linear-gradient(90deg,var(--navy-2),var(--red)) 1}
header.bar .inner{max-width:880px;margin:0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
header.bar h1{margin:0;font-size:18px;font-weight:800}
header.bar a{color:#d6dcec;text-decoration:none}
header.bar nav{display:flex;gap:16px;font-size:14px}
header.bar .who{color:#a8b3cd;font-size:13px}
main{max-width:880px;margin:24px auto;padding:0 24px 64px}
h2{font-size:22px;margin:0 0 12px;color:var(--navy)}
h3{font-size:17px;margin:24px 0 8px;color:var(--navy)}
p{color:var(--ink-2)}
.flash{padding:12px 16px;border-radius:8px;margin:0 0 16px;font-size:14px}
.flash-success{background:#e6f4ea;border:1px solid #9bcdab;color:#1f4d2c}
.flash-error{background:var(--redbg);border:1px solid #e3a8ad;color:#6b1c22}
.empty{padding:48px 16px;text-align:center;color:var(--ink-2);background:var(--card);border-radius:10px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:0.02em}
.badge-status-draft{background:var(--card);color:var(--ink-2)}
.badge-status-submitted,.badge-status-ai_review{background:#eef1fa;color:var(--navy-2)}
.badge-status-reviewer{background:#fff8e1;color:var(--yellow)}
.badge-status-approved,.badge-status-scheduled,.badge-status-published{background:#e6f4ea;color:var(--green)}
.badge-status-rejected{background:var(--redbg);color:var(--red)}
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
th{background:var(--card);font-weight:600;color:var(--navy);font-size:13px;text-transform:uppercase;letter-spacing:0.04em}
tr:hover td{background:#fafbfd}
.card{background:var(--card);border-radius:12px;padding:20px}
form fieldset{border:1px solid var(--rule);border-radius:10px;padding:14px 16px;margin:0 0 16px;background:#fff}
form legend{padding:0 8px;font-size:13px;color:var(--ink-2);font-weight:600;text-transform:uppercase;letter-spacing:0.04em}
form .help{font-size:13px;color:var(--ink-2);margin:0 0 8px}
label{display:block;font-weight:600;color:var(--navy);margin:0 0 6px;font-size:14px}
input[type=text],input[type=email],input[type=datetime-local],textarea,select{
  width:100%;padding:10px 12px;border:1px solid var(--rule);border-radius:8px;font-size:15px;background:#fff;color:var(--ink);font-family:inherit;line-height:1.4
}
input:focus,textarea:focus,select:focus{outline:2px solid var(--navy-2);outline-offset:2px}
textarea{min-height:96px;resize:vertical}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:680px){.row{grid-template-columns:1fr}}
.choice{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:14px;color:var(--ink)}
.choice:hover{background:#eef1fa}
.choice input{margin:0}
.choice .lvl{margin-left:auto;font-size:12px;color:var(--ink-2);text-transform:uppercase}
.targets-grid{max-height:280px;overflow:auto;border:1px solid var(--rule);border-radius:8px;padding:6px;background:#fff;margin:0 0 8px}
.btn{display:inline-block;background:var(--navy);color:#fff;border:none;padding:10px 22px;border-radius:8px;font-weight:600;font-size:15px;cursor:pointer;text-decoration:none}
.btn:hover,.btn:focus{background:var(--red)}
.btn.ghost{background:transparent;color:var(--navy);border:2px solid var(--navy);padding:8px 20px}
.btn.ghost:hover{background:var(--navy);color:#fff}
.btn.danger{background:var(--red)}.btn.danger:hover{background:#7c1820}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}
dl.kv{display:grid;grid-template-columns:160px 1fr;gap:8px 16px;margin:0;font-size:14px}
dl.kv dt{color:var(--ink-2);font-weight:600}
dl.kv dd{margin:0}
.subnav{font-size:13px;margin:0 0 12px}
.subnav a{margin-right:12px}
footer{border-top:1px solid var(--rule);padding:16px 24px;text-align:center;color:var(--ink-2);font-size:12px}`;

interface ShellOpts {
  title: string;
  user: { email: string };
  body: string;
  flash?: { kind: 'success' | 'error'; message: string };
}

function shell(opts: ShellOpts): string {
  const flash = opts.flash
    ? `<div class="flash flash-${opts.flash.kind}" role="status">${escapeHtml(opts.flash.message)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)} · DEF Flyers</title>
<meta name="robots" content="noindex">
<style>${SHARED_CSS}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>
<header class="bar"><div class="inner">
  <h1><a href="/submit/flyers" style="color:#fff;text-decoration:none;">DEF Flyers — submit</a></h1>
  <nav>
    <a href="/submit/flyers">My flyers</a>
    <a href="/submit/new">New flyer</a>
    <a href="/board">Board</a>
    <span class="who">${escapeHtml(opts.user.email)}</span>
    <form method="POST" action="/api/submitter/logout" style="display:inline;margin:0;">
      <button type="submit" style="background:transparent;border:none;color:#d6dcec;font-size:14px;cursor:pointer;padding:0;">Sign out</button>
    </form>
  </nav>
</div></header>
<main id="main">
  ${flash}
  ${opts.body}
</main>
<footer>Davis Education Foundation · <a href="https://daviskids.org">daviskids.org</a></footer>
</body>
</html>`;
}

// ─── DB lookups for picker fields ──────────────────────────────────────────

interface SchoolPick { id: string; name: string; level: string }
interface DeptPick { id: string; name: string }

async function listSchools(env: Bindings): Promise<SchoolPick[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, level FROM schools WHERE active = 1
     ORDER BY CASE level WHEN 'district' THEN 0 WHEN 'high' THEN 1 WHEN 'junior' THEN 2 WHEN 'elementary' THEN 3 ELSE 4 END, name`,
  ).all<SchoolPick>();
  return results;
}

async function listDepartments(env: Bindings): Promise<DeptPick[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name FROM departments WHERE active = 1 ORDER BY name`,
  ).all<DeptPick>();
  return results;
}

// ─── Form selection state (used to round-trip on validation errors) ───────

interface FormState {
  title: string;
  summary: string;
  audience: string;
  scope: string;
  category: string;
  expires_at: string; // datetime-local string
  body: string;
  event_start_at: string;
  event_end_at: string;
  event_location: string;
  image_alt_text: string;
  schools: string[];
  departments: string[];
}

function emptyFormState(): FormState {
  // Default expiry = 30 days out at 17:00 MT
  const inThirtyDays = Math.floor(Date.now() / 1000) + 30 * 86400;
  return {
    title: '',
    summary: '',
    audience: 'parents',
    scope: 'school',
    category: '',
    expires_at: unixToLocalInput(inThirtyDays),
    body: '',
    event_start_at: '',
    event_end_at: '',
    event_location: '',
    image_alt_text: '',
    schools: [],
    departments: [],
  };
}

function formStateFromBody(form: Record<string, string | File | (string | File)[]>): FormState {
  return {
    title: formFieldString(form, 'title'),
    summary: formFieldString(form, 'summary'),
    audience: formFieldString(form, 'audience'),
    scope: formFieldString(form, 'scope'),
    category: formFieldString(form, 'category'),
    expires_at: formFieldString(form, 'expires_at'),
    body: formFieldString(form, 'body'),
    event_start_at: formFieldString(form, 'event_start_at'),
    event_end_at: formFieldString(form, 'event_end_at'),
    event_location: formFieldString(form, 'event_location'),
    image_alt_text: formFieldString(form, 'image_alt_text'),
    schools: formFieldArray(form, 'schools'),
    departments: formFieldArray(form, 'departments'),
  };
}

function formStateFromFlyer(flyer: FlyerRow, schools: string[], departments: string[]): FormState {
  return {
    title: flyer.title,
    summary: flyer.summary,
    audience: flyer.audience,
    scope: flyer.scope,
    category: flyer.category,
    expires_at: unixToLocalInput(flyer.expires_at),
    body: flyer.body_plain || stripTags(flyer.body_html ?? ''),
    event_start_at: unixToLocalInput(flyer.event_start_at),
    event_end_at: unixToLocalInput(flyer.event_end_at),
    event_location: flyer.event_location ?? '',
    image_alt_text: flyer.image_alt_text ?? '',
    schools,
    departments,
  };
}

// Plain-text body → segmented HTML on save.
function bodyToHtml(plain: string): string {
  if (!plain.trim()) return '';
  return plain
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
    .join('\n');
}

// ─── Form rendering ────────────────────────────────────────────────────────

function flyerForm(opts: {
  formAction: string;
  state: FormState;
  schools: SchoolPick[];
  departments: DeptPick[];
  submitLabel: string;
}): string {
  const audienceRadios = ['parents', 'employees', 'both']
    .map(
      (a) =>
        `<label class="choice"><input type="radio" name="audience" value="${a}" ${
          opts.state.audience === a ? 'checked' : ''
        }> ${a === 'parents' ? 'Parents & families' : a === 'employees' ? 'DSD employees' : 'Both'}</label>`,
    )
    .join('');
  const scopeRadios = ['school', 'department', 'district']
    .map(
      (s) =>
        `<label class="choice"><input type="radio" name="scope" value="${s}" ${
          opts.state.scope === s ? 'checked' : ''
        }> ${s === 'school' ? 'Specific school(s)' : s === 'department' ? 'District department(s)' : 'District-wide'}</label>`,
    )
    .join('');
  const schoolBoxes = opts.schools
    .map(
      (s) =>
        `<label class="choice"><input type="checkbox" name="schools" value="${escapeHtml(s.id)}" ${
          opts.state.schools.includes(s.id) ? 'checked' : ''
        }> ${escapeHtml(s.name)}<span class="lvl">${escapeHtml(s.level)}</span></label>`,
    )
    .join('');
  const deptBoxes = opts.departments
    .map(
      (d) =>
        `<label class="choice"><input type="checkbox" name="departments" value="${escapeHtml(d.id)}" ${
          opts.state.departments.includes(d.id) ? 'checked' : ''
        }> ${escapeHtml(d.name)}</label>`,
    )
    .join('');

  return `<form method="POST" action="${escapeHtml(opts.formAction)}" novalidate>
  <fieldset>
    <legend>Basics</legend>
    <label for="title">Title <span style="color:var(--red);">*</span></label>
    <input id="title" name="title" type="text" required maxlength="200" value="${escapeHtml(opts.state.title)}" placeholder="Davis High Spring Carnival — May 17">

    <label for="summary" style="margin-top:12px;">Summary <span style="color:var(--red);">*</span></label>
    <p class="help">One or two sentences. Shown on the flyer board and at the top of the email.</p>
    <textarea id="summary" name="summary" required maxlength="500" rows="2">${escapeHtml(opts.state.summary)}</textarea>

    <label for="category" style="margin-top:12px;">Category <span style="color:var(--red);">*</span></label>
    <p class="help">Short tag (e.g. "Community Event", "After-school program", "Health & Wellness").</p>
    <input id="category" name="category" type="text" required maxlength="100" value="${escapeHtml(opts.state.category)}">
  </fieldset>

  <fieldset>
    <legend>Audience &amp; targeting</legend>
    <label>Audience <span style="color:var(--red);">*</span></label>
    <div>${audienceRadios}</div>

    <label style="margin-top:12px;">Scope <span style="color:var(--red);">*</span></label>
    <div>${scopeRadios}</div>

    <label style="margin-top:14px;" id="schools-label">Schools <span style="color:var(--ink-2);font-weight:400;">(required if scope is "Specific school(s)")</span></label>
    <div class="targets-grid" aria-labelledby="schools-label">${schoolBoxes}</div>

    <label style="margin-top:8px;" id="depts-label">Departments <span style="color:var(--ink-2);font-weight:400;">(required if scope is "District department(s)")</span></label>
    <div class="targets-grid" aria-labelledby="depts-label">${deptBoxes}</div>
  </fieldset>

  <fieldset>
    <legend>Body</legend>
    <p class="help">Plain text only. Leave blank lines between paragraphs. (HTML is added automatically. Required if no PDF/image is uploaded.)</p>
    <textarea id="body" name="body" rows="8">${escapeHtml(opts.state.body)}</textarea>
  </fieldset>

  <fieldset>
    <legend>Event details (optional)</legend>
    <div class="row">
      <div>
        <label for="event_start_at">Event start (Mountain Time)</label>
        <input id="event_start_at" name="event_start_at" type="datetime-local" value="${escapeHtml(opts.state.event_start_at)}">
      </div>
      <div>
        <label for="event_end_at">Event end</label>
        <input id="event_end_at" name="event_end_at" type="datetime-local" value="${escapeHtml(opts.state.event_end_at)}">
      </div>
    </div>
    <label for="event_location" style="margin-top:12px;">Location</label>
    <input id="event_location" name="event_location" type="text" maxlength="200" value="${escapeHtml(opts.state.event_location)}">
  </fieldset>

  <fieldset>
    <legend>Image (optional)</legend>
    <p class="help">If you'll upload a cover image after creating the draft, describe it here for screen readers. Leave blank for now if no image.</p>
    <label for="image_alt_text">Image alt text</label>
    <input id="image_alt_text" name="image_alt_text" type="text" maxlength="500" value="${escapeHtml(opts.state.image_alt_text)}">
  </fieldset>

  <fieldset>
    <legend>Schedule</legend>
    <label for="expires_at">Expires <span style="color:var(--red);">*</span></label>
    <p class="help">After this date the flyer is hidden from the public board. Default 30 days from now.</p>
    <input id="expires_at" name="expires_at" type="datetime-local" required value="${escapeHtml(opts.state.expires_at)}">
  </fieldset>

  <div class="actions">
    <button type="submit" class="btn">${escapeHtml(opts.submitLabel)}</button>
    <a class="btn ghost" href="/submit/flyers">Cancel</a>
  </div>
</form>`;
}

// ─── Validation: form-state → fields-ready-for-DB ──────────────────────────

interface ParsedFields {
  title: string;
  summary: string;
  audience: string;
  scope: string;
  category: string;
  expires_at: number;
  body_plain: string;
  body_html: string;
  event_start_at: number | null;
  event_end_at: number | null;
  event_location: string | null;
  image_alt_text: string | null;
  schools: string[];
  departments: string[];
}

interface ParseError {
  message: string;
}

async function parseAndValidate(
  env: Bindings,
  state: FormState,
): Promise<{ ok: true; fields: ParsedFields } | { ok: false; error: ParseError }> {
  const title = asTrimmedString(state.title, 200);
  if (!title) return { ok: false, error: { message: 'Title is required and must be under 200 characters.' } };
  const summary = asTrimmedString(state.summary, 500);
  if (!summary) return { ok: false, error: { message: 'Summary is required and must be under 500 characters.' } };
  if (!AUDIENCES.has(state.audience)) {
    return { ok: false, error: { message: 'Pick an audience.' } };
  }
  if (!SCOPES.has(state.scope)) {
    return { ok: false, error: { message: 'Pick a scope.' } };
  }
  const category = asTrimmedString(state.category, 100);
  if (!category) return { ok: false, error: { message: 'Category is required.' } };

  const expires = parseLocalDateTime(state.expires_at);
  if (expires === null) return { ok: false, error: { message: 'Pick a valid expiry date.' } };
  const now = Math.floor(Date.now() / 1000);
  if (expires <= now) return { ok: false, error: { message: 'Expiry must be in the future.' } };

  const eventStart = state.event_start_at ? parseLocalDateTime(state.event_start_at) : null;
  if (state.event_start_at && eventStart === null) {
    return { ok: false, error: { message: 'Event start time isn’t valid.' } };
  }
  const eventEnd = state.event_end_at ? parseLocalDateTime(state.event_end_at) : null;
  if (state.event_end_at && eventEnd === null) {
    return { ok: false, error: { message: 'Event end time isn’t valid.' } };
  }
  if (eventStart !== null && eventEnd !== null && eventEnd < eventStart) {
    return { ok: false, error: { message: 'Event end must be after event start.' } };
  }

  const eventLocation = asTrimmedString(state.event_location, 200);
  // event_location is optional; null when blank
  const imageAlt = asTrimmedString(state.image_alt_text, 500);

  const schoolsArr = asStringArray(state.schools) ?? [];
  const departmentsArr = asStringArray(state.departments) ?? [];

  const targetCheck = await validateScopeTargets(env, state.scope, schoolsArr, departmentsArr);
  if (!targetCheck.ok) {
    const map: Record<string, string> = {
      schools_required: 'Pick at least one school for school-scoped flyers.',
      departments_required: 'Pick at least one department for department-scoped flyers.',
      schools_not_allowed_for_department_scope: 'Department scope cannot select schools.',
      departments_not_allowed_for_school_scope: 'School scope cannot select departments.',
      targeting_not_allowed_for_district_scope: 'District-wide flyers don’t pick schools or departments — uncheck them.',
      unknown_school: 'One of the selected schools isn’t in our list.',
      unknown_department: 'One of the selected departments isn’t in our list.',
    };
    return { ok: false, error: { message: map[targetCheck.error] ?? targetCheck.error } };
  }

  const bodyPlain = state.body.trim();
  const bodyHtml = bodyToHtml(bodyPlain);

  return {
    ok: true,
    fields: {
      title,
      summary,
      audience: state.audience,
      scope: state.scope,
      category,
      expires_at: expires,
      body_plain: bodyPlain,
      body_html: bodyHtml,
      event_start_at: eventStart,
      event_end_at: eventEnd,
      event_location: eventLocation,
      image_alt_text: imageAlt,
      schools: schoolsArr,
      departments: departmentsArr,
    },
  };
}

// ─── List view ─────────────────────────────────────────────────────────────

interface FlyerListRow {
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
  updated_at: number;
  image_r2_key: string | null;
  pdf_r2_key: string | null;
}

pages.get('/submit/flyers', async (c) => {
  const user = c.get('user');
  const flash = readFlash(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, title, summary, audience, scope, category, status,
            expires_at, submitted_at, updated_at, image_r2_key, pdf_r2_key
     FROM flyers WHERE submitted_by = ? ORDER BY updated_at DESC LIMIT 100`,
  )
    .bind(user.id)
    .all<FlyerListRow>();

  const rows = results
    .map((r) => {
      const artifacts = [r.pdf_r2_key ? '📄' : '', r.image_r2_key ? '🖼️' : ''].join(' ').trim();
      return `<tr>
        <td><a href="/submit/flyer/${escapeHtml(r.id)}" style="font-weight:600;">${escapeHtml(r.title)}</a>
          <div style="font-size:12px;color:var(--ink-2);">${escapeHtml(r.audience)} · ${escapeHtml(r.scope)} · ${escapeHtml(r.category)}${artifacts ? ' · ' + artifacts : ''}</div></td>
        <td><span class="badge badge-status-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
        <td>${escapeHtml(fmtRelative(r.updated_at))}</td>
        <td>${escapeHtml(fmtTime(r.expires_at))}</td>
      </tr>`;
    })
    .join('');

  const body = results.length > 0
    ? `<h2>My flyers</h2>
       <p style="margin:0 0 12px;"><a class="btn" href="/submit/new">New flyer</a></p>
       <table>
         <thead><tr>
           <th>Flyer</th><th>Status</th><th>Last update</th><th>Expires</th>
         </tr></thead>
         <tbody>${rows}</tbody>
       </table>`
    : `<h2>My flyers</h2>
       <div class="empty">You haven't created any flyers yet.<br>
       <a class="btn" style="margin-top:16px;" href="/submit/new">Create your first flyer</a></div>`;

  return c.html(shell({ title: 'My flyers', user, body, flash }));
});

// ─── Create form ───────────────────────────────────────────────────────────

pages.get('/submit/new', async (c) => {
  const user = c.get('user');
  const [schools, departments] = await Promise.all([listSchools(c.env), listDepartments(c.env)]);
  const body = `<p class="subnav"><a href="/submit/flyers">← My flyers</a></p>
    <h2>New flyer</h2>
    <p>Fill out the structured fields below. You can attach a PDF or image after the draft is created.</p>
    ${flyerForm({
      formAction: '/submit/new',
      state: emptyFormState(),
      schools,
      departments,
      submitLabel: 'Save draft',
    })}`;
  return c.html(shell({ title: 'New flyer', user, body }));
});

pages.post('/submit/new', async (c) => {
  const user = c.get('user');
  const form = await c.req.parseBody();
  const state = formStateFromBody(form);
  const parsed = await parseAndValidate(c.env, state);

  if (!parsed.ok) {
    const [schools, departments] = await Promise.all([listSchools(c.env), listDepartments(c.env)]);
    const body = `<p class="subnav"><a href="/submit/flyers">← My flyers</a></p>
      <h2>New flyer</h2>
      ${flyerForm({
        formAction: '/submit/new',
        state,
        schools,
        departments,
        submitLabel: 'Save draft',
      })}`;
    return c.html(
      shell({ title: 'New flyer', user, body, flash: { kind: 'error', message: parsed.error.message } }),
      400,
    );
  }

  const f = parsed.fields;
  const id = ulid();
  const slug = slugWithSuffix(f.title, id);
  const r = analyze(f.body_plain || stripTags(f.body_html));
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `INSERT INTO flyers (
       id, slug, title, summary, body_html, body_plain,
       reading_level, word_count,
       audience, scope, category, tags,
       status, expires_at,
       event_start_at, event_end_at, event_location,
       image_alt_text,
       submitted_by, submitted_at, updated_at, version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(
      id, slug, f.title, f.summary, f.body_html, f.body_plain,
      r.reading_level, r.word_count,
      f.audience, f.scope, f.category,
      f.expires_at,
      f.event_start_at, f.event_end_at, f.event_location,
      f.image_alt_text,
      user.id, now, now,
    )
    .run();

  await writeFlyerTargets(c.env, id, f.schools, f.departments);

  setFlash(c, 'success', `Draft saved: "${f.title}". Add a PDF/image and click Submit when ready.`);
  return c.redirect(`/submit/flyer/${id}`, 303);
});

// ─── Detail view ───────────────────────────────────────────────────────────

pages.get('/submit/flyer/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const flash = readFlash(c);
  const flyer = await loadFlyerForOwner(c.env, id, user.id);
  if (!flyer) {
    return c.html(shell({ title: 'Not found', user, body: '<h2>Not found</h2><p><a href="/submit/flyers">Back to my flyers</a></p>' }), 404);
  }

  const targets = await loadFlyerTargets(c.env, id);
  const [schools, departments] = await Promise.all([listSchools(c.env), listDepartments(c.env)]);
  const targetSchools = schools.filter((s) => targets.schools.includes(s.id));
  const targetDepts = departments.filter((d) => targets.departments.includes(d.id));

  const isDraft = flyer.status === 'draft';

  const summaryDl = `<dl class="kv">
    <dt>Status</dt><dd><span class="badge badge-status-${escapeHtml(flyer.status)}">${escapeHtml(flyer.status)}</span> · v${flyer.version}</dd>
    <dt>Audience / scope</dt><dd>${escapeHtml(flyer.audience)} / ${escapeHtml(flyer.scope)}</dd>
    <dt>Targets</dt><dd>${
      flyer.scope === 'school'
        ? targetSchools.map((s) => escapeHtml(s.name)).join(', ') || '—'
        : flyer.scope === 'department'
          ? targetDepts.map((d) => escapeHtml(d.name)).join(', ') || '—'
          : 'District-wide'
    }</dd>
    <dt>Category</dt><dd>${escapeHtml(flyer.category)}</dd>
    <dt>Reading grade</dt><dd>${flyer.reading_level !== null ? flyer.reading_level.toFixed(1) : '—'} · ${flyer.word_count ?? 0} words</dd>
    ${flyer.event_start_at ? `<dt>Event</dt><dd>${escapeHtml(fmtTime(flyer.event_start_at))}${flyer.event_end_at ? ' → ' + escapeHtml(fmtTime(flyer.event_end_at)) : ''}${flyer.event_location ? ' · ' + escapeHtml(flyer.event_location) : ''}</dd>` : ''}
    <dt>Expires</dt><dd>${escapeHtml(fmtTime(flyer.expires_at))}</dd>
    <dt>Submitted</dt><dd>${escapeHtml(fmtTime(flyer.submitted_at))} · last edit ${escapeHtml(fmtRelative(flyer.updated_at))}</dd>
    ${flyer.rejected_reason ? `<dt>Reviewer rejected</dt><dd style="color:var(--red);">${escapeHtml(flyer.rejected_reason)}</dd>` : ''}
  </dl>`;

  const editForm = isDraft
    ? `<h3>Edit draft</h3>
       ${flyerForm({
         formAction: `/submit/flyer/${escapeHtml(flyer.id)}`,
         state: formStateFromFlyer(flyer, targets.schools, targets.departments),
         schools,
         departments,
         submitLabel: 'Save changes',
       })}`
    : '';

  const uploadBlock = isDraft
    ? `<h3>Attach a file (optional)</h3>
       <p class="help">PDF or image (JPEG, PNG, WebP). Max 10 MB. Re-uploading replaces the previous file.</p>
       <form method="POST" action="/submit/flyer/${escapeHtml(flyer.id)}/upload" enctype="multipart/form-data" class="card">
         <label for="kind">Kind</label>
         <select id="kind" name="kind"><option value="pdf">PDF (supplemental)</option><option value="image">Cover image</option></select>
         <label for="file" style="margin-top:10px;">File</label>
         <input id="file" name="file" type="file" required>
         <div class="actions"><button type="submit" class="btn ghost">Upload</button></div>
       </form>
       ${flyer.pdf_r2_key ? `<p style="margin-top:8px;font-size:13px;">Current PDF: <code>${escapeHtml(flyer.pdf_r2_key)}</code></p>` : ''}
       ${flyer.image_r2_key ? `<p style="margin-top:8px;font-size:13px;">Current image: <code>${escapeHtml(flyer.image_r2_key)}</code></p>` : ''}`
    : '';

  const finalizeBlock = isDraft
    ? `<h3>Submit for review</h3>
       <p class="help">Once submitted, the AI pipeline runs (translation, moderation, accessibility check) and a DEF reviewer takes over. You can't edit while it's under review.</p>
       <form method="POST" action="/submit/flyer/${escapeHtml(flyer.id)}/finalize">
         <button type="submit" class="btn">Submit for review</button>
       </form>`
    : `<p style="margin-top:24px;color:var(--ink-2);">This flyer is currently <strong>${escapeHtml(flyer.status)}</strong>. ${
        flyer.status === 'rejected' || flyer.status === 'draft'
          ? 'Use the form above to make changes and re-submit.'
          : flyer.status === 'published'
            ? `View it on the <a href="/board">board</a> or <a href="/flyer/${escapeHtml(flyer.slug)}">direct link</a>.`
            : 'Once a reviewer acts, you\'ll be notified by email.'
      }</p>`;

  const body = `
    <p class="subnav"><a href="/submit/flyers">← My flyers</a></p>
    <h2>${escapeHtml(flyer.title)}</h2>
    <p>${escapeHtml(flyer.summary)}</p>
    ${summaryDl}
    ${editForm}
    ${uploadBlock}
    ${finalizeBlock}
  `;

  return c.html(shell({ title: flyer.title, user, body, flash }));
});

// ─── Edit handler ──────────────────────────────────────────────────────────

pages.post('/submit/flyer/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const flyer = await loadFlyerForOwner(c.env, id, user.id);
  if (!flyer) {
    setFlash(c, 'error', 'Flyer not found.');
    return c.redirect('/submit/flyers', 303);
  }
  if (flyer.status !== 'draft') {
    setFlash(c, 'error', `Flyer is ${flyer.status} — cannot edit.`);
    return c.redirect(`/submit/flyer/${id}`, 303);
  }

  const form = await c.req.parseBody();
  const state = formStateFromBody(form);
  const parsed = await parseAndValidate(c.env, state);
  if (!parsed.ok) {
    setFlash(c, 'error', parsed.error.message);
    return c.redirect(`/submit/flyer/${id}`, 303);
  }

  const f = parsed.fields;
  const r = analyze(f.body_plain || stripTags(f.body_html));
  const now = Math.floor(Date.now() / 1000);
  const newSlug = slugWithSuffix(f.title, id);

  await c.env.DB.prepare(
    `UPDATE flyers SET
       title = ?, slug = ?, summary = ?, body_html = ?, body_plain = ?,
       reading_level = ?, word_count = ?,
       audience = ?, scope = ?, category = ?, expires_at = ?,
       event_start_at = ?, event_end_at = ?, event_location = ?,
       image_alt_text = ?, updated_at = ?
     WHERE id = ? AND submitted_by = ?`,
  )
    .bind(
      f.title, newSlug, f.summary, f.body_html, f.body_plain,
      r.reading_level, r.word_count,
      f.audience, f.scope, f.category, f.expires_at,
      f.event_start_at, f.event_end_at, f.event_location,
      f.image_alt_text, now,
      id, user.id,
    )
    .run();

  await writeFlyerTargets(c.env, id, f.schools, f.departments);

  setFlash(c, 'success', 'Changes saved.');
  return c.redirect(`/submit/flyer/${id}`, 303);
});

// ─── Upload handler ────────────────────────────────────────────────────────

pages.post('/submit/flyer/:id/upload', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const flyer = await loadFlyerForOwner(c.env, id, user.id);
  if (!flyer) {
    setFlash(c, 'error', 'Flyer not found.');
    return c.redirect('/submit/flyers', 303);
  }
  if (flyer.status !== 'draft') {
    setFlash(c, 'error', `Flyer is ${flyer.status} — uploads disabled.`);
    return c.redirect(`/submit/flyer/${id}`, 303);
  }

  const form = await c.req.parseBody();
  const kind = formFieldString(form, 'kind');
  if (!ALLOWED_UPLOAD_KINDS.has(kind)) {
    setFlash(c, 'error', 'Pick PDF or image.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }
  const file = form.file;
  if (!(file instanceof File)) {
    setFlash(c, 'error', 'No file chosen.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }
  if (file.size === 0) {
    setFlash(c, 'error', 'The chosen file is empty.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    setFlash(c, 'error', 'File is over the 10 MB limit.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }
  if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
    setFlash(c, 'error', 'File type must be PDF, JPEG, PNG, or WebP.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }
  if (kind === 'pdf' && file.type !== 'application/pdf') {
    setFlash(c, 'error', 'Kind="PDF" requires a PDF file.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }
  if (kind === 'image' && file.type === 'application/pdf') {
    setFlash(c, 'error', 'Kind="image" requires an image file.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }

  const ext = EXT_BY_TYPE[file.type];
  const key = `flyers/${id}/${kind}-${ulid()}.${ext}`;

  await c.env.ASSETS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { flyer_id: id, uploaded_by: user.id, kind },
  });

  const now = Math.floor(Date.now() / 1000);
  if (kind === 'pdf') {
    if (flyer.pdf_r2_key && flyer.pdf_r2_key !== key) {
      await c.env.ASSETS.delete(flyer.pdf_r2_key).catch(() => {});
    }
    await c.env.DB.prepare(
      `UPDATE flyers SET pdf_r2_key = ?, updated_at = ? WHERE id = ? AND submitted_by = ?`,
    )
      .bind(key, now, id, user.id)
      .run();
  } else {
    if (flyer.image_r2_key && flyer.image_r2_key !== key) {
      await c.env.ASSETS.delete(flyer.image_r2_key).catch(() => {});
    }
    await c.env.DB.prepare(
      `UPDATE flyers SET image_r2_key = ?, updated_at = ? WHERE id = ? AND submitted_by = ?`,
    )
      .bind(key, now, id, user.id)
      .run();
  }

  setFlash(c, 'success', `${kind === 'pdf' ? 'PDF' : 'Image'} uploaded.`);
  return c.redirect(`/submit/flyer/${id}`, 303);
});

// ─── Finalize handler ──────────────────────────────────────────────────────

pages.post('/submit/flyer/:id/finalize', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const flyer = await loadFlyerForOwner(c.env, id, user.id);
  if (!flyer) {
    setFlash(c, 'error', 'Flyer not found.');
    return c.redirect('/submit/flyers', 303);
  }
  if (flyer.status !== 'draft') {
    setFlash(c, 'error', `Already ${flyer.status}.`);
    return c.redirect(`/submit/flyer/${id}`, 303);
  }

  const hasBody = (flyer.body_plain && flyer.body_plain.trim().length > 0) ||
                  (flyer.body_html && flyer.body_html.trim().length > 0);
  const hasArtifact = !!flyer.pdf_r2_key || !!flyer.image_r2_key;
  if (!hasBody && !hasArtifact) {
    setFlash(c, 'error', 'Add body text or upload a PDF/image before submitting.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }

  const targets = await loadFlyerTargets(c.env, id);
  const t = await validateScopeTargets(c.env, flyer.scope, targets.schools, targets.departments);
  if (!t.ok) {
    setFlash(c, 'error', `Targeting issue: ${t.error}. Fix the scope/schools/departments and retry.`);
    return c.redirect(`/submit/flyer/${id}`, 303);
  }

  const now = Math.floor(Date.now() / 1000);
  if (flyer.expires_at <= now) {
    setFlash(c, 'error', 'Expiry is in the past — pick a future date.');
    return c.redirect(`/submit/flyer/${id}`, 303);
  }

  const snapshot = JSON.stringify({ flyer, targets, finalized_at: now });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO flyer_revisions (flyer_id, version, snapshot, changed_by, changed_at, change_note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, flyer.version, snapshot, user.id, now, 'finalized for review'),
    c.env.DB.prepare(
      `UPDATE flyers SET status = 'submitted', submitted_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND submitted_by = ?`,
    ).bind(now, now, id, user.id),
  ]);

  c.executionCtx.waitUntil(
    runAiPipeline(c.env, id).catch((err) => console.error('[ai-pipeline] uncaught', id, err)),
  );

  setFlash(c, 'success', `"${flyer.title}" submitted. We'll email you when the reviewer responds (typically within 24 hours).`);
  return c.redirect('/submit/flyers', 303);
});

// expose IP helper for future use; satisfies "no unused" lint warnings.
void clientIp;

export default pages;
