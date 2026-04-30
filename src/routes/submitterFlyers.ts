// Section 2.2 — submission flow.
// All routes here require an authenticated submitter session.
//
//   POST   /api/submitter/submit              create draft flyer
//   GET    /api/submitter/flyers              list own flyers
//   GET    /api/submitter/flyer/:id           fetch one
//   PATCH  /api/submitter/flyer/:id           update (draft only)
//   POST   /api/submitter/flyer/:id/upload    multipart, sets pdf_r2_key|image_r2_key
//   POST   /api/submitter/flyer/:id/finalize  status → submitted, snapshot, queue AI

import { Hono } from 'hono';
import type { Bindings } from '../index';
import { requireSession, type AppVariables } from '../auth/session';
import { ulid } from '../lib/ulid';
import { slugWithSuffix } from '../lib/slug';
import { analyze } from '../lib/readability';
import { runAiPipeline } from '../ai/pipeline';

const api = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

api.use('*', requireSession());

export const AUDIENCES = new Set(['parents', 'employees', 'both']);
export const SCOPES = new Set(['school', 'department', 'district']);
export const ALLOWED_UPLOAD_KINDS = new Set(['pdf', 'image']);
export const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
export const EXT_BY_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface SubmitBody {
  title?: unknown;
  summary?: unknown;
  audience?: unknown;
  scope?: unknown;
  category?: unknown;
  expires_at?: unknown;
  body_html?: unknown;
  body_plain?: unknown;
  event_start_at?: unknown;
  event_end_at?: unknown;
  event_location?: unknown;
  image_alt_text?: unknown;
  tags?: unknown;
  schools?: unknown;
  departments?: unknown;
}

interface PatchBody extends SubmitBody {
  pdf_r2_key?: unknown;
  image_r2_key?: unknown;
}

export function asTrimmedString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max) return null;
  return s;
}

export function asUnixSeconds(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Accept either seconds or ms; normalise to seconds.
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
}

export function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') return null;
    const s = item.trim();
    if (!s) return null;
    out.push(s);
  }
  return out;
}

export interface FlyerRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body_html: string;
  body_plain: string;
  reading_level: number | null;
  word_count: number | null;
  audience: string;
  scope: string;
  category: string;
  tags: string | null;
  status: string;
  published_at: number | null;
  expires_at: number;
  event_start_at: number | null;
  event_end_at: number | null;
  event_location: string | null;
  image_r2_key: string | null;
  image_alt_text: string | null;
  pdf_r2_key: string | null;
  pdf_a11y_score: number | null;
  pdf_a11y_passed: number | null;
  submitted_by: string;
  submitted_at: number;
  approved_by: string | null;
  approved_at: number | null;
  rejected_reason: string | null;
  updated_at: number;
  version: number;
}

export async function loadFlyerForOwner(
  env: Bindings,
  flyerId: string,
  userId: string,
): Promise<FlyerRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM flyers WHERE id = ? AND submitted_by = ?`,
  )
    .bind(flyerId, userId)
    .first<FlyerRow>();
  return row ?? null;
}

export async function loadFlyerTargets(
  env: Bindings,
  flyerId: string,
): Promise<{ schools: string[]; departments: string[] }> {
  const [schools, departments] = await Promise.all([
    env.DB.prepare(`SELECT school_id FROM flyer_schools WHERE flyer_id = ?`)
      .bind(flyerId)
      .all<{ school_id: string }>(),
    env.DB.prepare(`SELECT department_id FROM flyer_departments WHERE flyer_id = ?`)
      .bind(flyerId)
      .all<{ department_id: string }>(),
  ]);
  return {
    schools: schools.results.map((r) => r.school_id),
    departments: departments.results.map((r) => r.department_id),
  };
}

function flyerToJson(row: FlyerRow, targets: { schools: string[]; departments: string[] }) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body_html: row.body_html,
    body_plain: row.body_plain,
    reading_level: row.reading_level,
    word_count: row.word_count,
    audience: row.audience,
    scope: row.scope,
    category: row.category,
    tags: row.tags ? safeJsonArray(row.tags) : [],
    status: row.status,
    published_at: row.published_at,
    expires_at: row.expires_at,
    event_start_at: row.event_start_at,
    event_end_at: row.event_end_at,
    event_location: row.event_location,
    image_r2_key: row.image_r2_key,
    image_alt_text: row.image_alt_text,
    pdf_r2_key: row.pdf_r2_key,
    pdf_a11y_score: row.pdf_a11y_score,
    pdf_a11y_passed: !!row.pdf_a11y_passed,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    rejected_reason: row.rejected_reason,
    updated_at: row.updated_at,
    version: row.version,
    schools: targets.schools,
    departments: targets.departments,
  };
}

function safeJsonArray(v: string): unknown[] {
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function validateScopeTargets(
  env: Bindings,
  scope: string,
  schoolIds: string[],
  departmentIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (scope === 'school') {
    if (schoolIds.length === 0) return { ok: false, error: 'schools_required' };
    if (departmentIds.length > 0) return { ok: false, error: 'departments_not_allowed_for_school_scope' };
    const placeholders = schoolIds.map(() => '?').join(',');
    const found = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM schools WHERE id IN (${placeholders}) AND active = 1`,
    )
      .bind(...schoolIds)
      .first<{ n: number }>();
    if (!found || found.n !== schoolIds.length) return { ok: false, error: 'unknown_school' };
  } else if (scope === 'department') {
    if (departmentIds.length === 0) return { ok: false, error: 'departments_required' };
    if (schoolIds.length > 0) return { ok: false, error: 'schools_not_allowed_for_department_scope' };
    const placeholders = departmentIds.map(() => '?').join(',');
    const found = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM departments WHERE id IN (${placeholders}) AND active = 1`,
    )
      .bind(...departmentIds)
      .first<{ n: number }>();
    if (!found || found.n !== departmentIds.length) {
      return { ok: false, error: 'unknown_department' };
    }
  } else {
    // district
    if (schoolIds.length > 0 || departmentIds.length > 0) {
      return { ok: false, error: 'targeting_not_allowed_for_district_scope' };
    }
  }
  return { ok: true };
}

export async function writeFlyerTargets(
  env: Bindings,
  flyerId: string,
  schoolIds: string[],
  departmentIds: string[],
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM flyer_schools WHERE flyer_id = ?`).bind(flyerId),
    env.DB.prepare(`DELETE FROM flyer_departments WHERE flyer_id = ?`).bind(flyerId),
    ...schoolIds.map((sid) =>
      env.DB.prepare(`INSERT INTO flyer_schools (flyer_id, school_id) VALUES (?, ?)`).bind(
        flyerId,
        sid,
      ),
    ),
    ...departmentIds.map((did) =>
      env.DB.prepare(
        `INSERT INTO flyer_departments (flyer_id, department_id) VALUES (?, ?)`,
      ).bind(flyerId, did),
    ),
  ]);
}

// ─── POST /api/submitter/submit ────────────────────────────────────────────
api.post('/submit', async (c) => {
  const user = c.get('user');
  let body: SubmitBody;
  try {
    body = (await c.req.json()) as SubmitBody;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const title = asTrimmedString(body.title, 200);
  if (!title) return c.json({ error: 'invalid_title' }, 400);

  const summary = asTrimmedString(body.summary, 500);
  if (!summary) return c.json({ error: 'invalid_summary' }, 400);

  const audience = typeof body.audience === 'string' ? body.audience : '';
  if (!AUDIENCES.has(audience)) return c.json({ error: 'invalid_audience' }, 400);

  const scope = typeof body.scope === 'string' ? body.scope : '';
  if (!SCOPES.has(scope)) return c.json({ error: 'invalid_scope' }, 400);

  const category = asTrimmedString(body.category, 100);
  if (!category) return c.json({ error: 'invalid_category' }, 400);

  const expiresAt = asUnixSeconds(body.expires_at);
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt === null || expiresAt <= now) {
    return c.json({ error: 'invalid_expires_at', message: 'expires_at must be a future unix timestamp (seconds)' }, 400);
  }

  const schools = body.schools !== undefined ? asStringArray(body.schools) : [];
  if (schools === null) return c.json({ error: 'invalid_schools' }, 400);
  const departments = body.departments !== undefined ? asStringArray(body.departments) : [];
  if (departments === null) return c.json({ error: 'invalid_departments' }, 400);

  const targetCheck = await validateScopeTargets(c.env, scope, schools, departments);
  if (!targetCheck.ok) return c.json({ error: targetCheck.error }, 400);

  const bodyHtml = typeof body.body_html === 'string' ? body.body_html : '';
  const bodyPlain = typeof body.body_plain === 'string' ? body.body_plain : '';
  const readability = analyze(bodyPlain || stripTags(bodyHtml));

  const eventStart = body.event_start_at !== undefined ? asUnixSeconds(body.event_start_at) : null;
  const eventEnd = body.event_end_at !== undefined ? asUnixSeconds(body.event_end_at) : null;
  if (
    eventStart !== null &&
    eventEnd !== null &&
    eventEnd < eventStart
  ) {
    return c.json({ error: 'invalid_event_window' }, 400);
  }
  const eventLocation = body.event_location !== undefined
    ? asTrimmedString(body.event_location, 200)
    : null;
  if (body.event_location !== undefined && eventLocation === null && body.event_location !== '') {
    return c.json({ error: 'invalid_event_location' }, 400);
  }

  const imageAlt = body.image_alt_text !== undefined
    ? asTrimmedString(body.image_alt_text, 500)
    : null;

  let tagsJson: string | null = null;
  if (body.tags !== undefined) {
    const tags = asStringArray(body.tags);
    if (tags === null) return c.json({ error: 'invalid_tags' }, 400);
    tagsJson = JSON.stringify(tags);
  }

  const id = ulid();
  const slug = slugWithSuffix(title, id);

  await c.env.DB.prepare(
    `INSERT INTO flyers (
       id, slug, title, summary, body_html, body_plain,
       reading_level, word_count,
       audience, scope, category, tags,
       status, expires_at,
       event_start_at, event_end_at, event_location,
       image_alt_text,
       submitted_by, submitted_at, updated_at, version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(
      id,
      slug,
      title,
      summary,
      bodyHtml,
      bodyPlain,
      readability.reading_level,
      readability.word_count,
      audience,
      scope,
      category,
      tagsJson,
      expiresAt,
      eventStart,
      eventEnd,
      eventLocation,
      imageAlt,
      user.id,
      now,
      now,
    )
    .run();

  await writeFlyerTargets(c.env, id, schools, departments);

  return c.json({
    flyer_id: id,
    slug,
    status: 'draft',
    reading_level: readability.reading_level,
    word_count: readability.word_count,
  }, 201);
});

// ─── GET /api/submitter/flyers ─────────────────────────────────────────────
api.get('/flyers', async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, title, summary, audience, scope, category, status,
            expires_at, submitted_at, updated_at, image_r2_key, pdf_r2_key
     FROM flyers
     WHERE submitted_by = ?
     ORDER BY updated_at DESC
     LIMIT 100`,
  )
    .bind(user.id)
    .all();
  return c.json({ flyers: results, count: results.length });
});

// ─── GET /api/submitter/flyer/:id ──────────────────────────────────────────
api.get('/flyer/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = await loadFlyerForOwner(c.env, id, user.id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  const targets = await loadFlyerTargets(c.env, id);
  return c.json({ flyer: flyerToJson(row, targets) });
});

// ─── PATCH /api/submitter/flyer/:id ────────────────────────────────────────
// Allowed only while status='draft'.
api.patch('/flyer/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = await loadFlyerForOwner(c.env, id, user.id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status !== 'draft') {
    return c.json({ error: 'not_editable', message: `flyer status is ${row.status}` }, 409);
  }

  let body: PatchBody;
  try {
    body = (await c.req.json()) as PatchBody;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  function set(col: string, val: string | number | null) {
    updates.push(`${col} = ?`);
    values.push(val);
  }

  if (body.title !== undefined) {
    const title = asTrimmedString(body.title, 200);
    if (!title) return c.json({ error: 'invalid_title' }, 400);
    set('title', title);
    set('slug', slugWithSuffix(title, row.id));
  }
  if (body.summary !== undefined) {
    const summary = asTrimmedString(body.summary, 500);
    if (!summary) return c.json({ error: 'invalid_summary' }, 400);
    set('summary', summary);
  }
  if (body.audience !== undefined) {
    if (typeof body.audience !== 'string' || !AUDIENCES.has(body.audience)) {
      return c.json({ error: 'invalid_audience' }, 400);
    }
    set('audience', body.audience);
  }
  if (body.category !== undefined) {
    const category = asTrimmedString(body.category, 100);
    if (!category) return c.json({ error: 'invalid_category' }, 400);
    set('category', category);
  }
  if (body.expires_at !== undefined) {
    const exp = asUnixSeconds(body.expires_at);
    if (exp === null) return c.json({ error: 'invalid_expires_at' }, 400);
    set('expires_at', exp);
  }
  if (body.body_html !== undefined) {
    if (typeof body.body_html !== 'string') return c.json({ error: 'invalid_body_html' }, 400);
    set('body_html', body.body_html);
  }
  if (body.body_plain !== undefined) {
    if (typeof body.body_plain !== 'string') return c.json({ error: 'invalid_body_plain' }, 400);
    set('body_plain', body.body_plain);
    const r = analyze(body.body_plain);
    set('reading_level', r.reading_level);
    set('word_count', r.word_count);
  }
  if (body.event_start_at !== undefined) {
    set('event_start_at', body.event_start_at === null ? null : asUnixSeconds(body.event_start_at));
  }
  if (body.event_end_at !== undefined) {
    set('event_end_at', body.event_end_at === null ? null : asUnixSeconds(body.event_end_at));
  }
  if (body.event_location !== undefined) {
    if (body.event_location === null || body.event_location === '') {
      set('event_location', null);
    } else {
      const loc = asTrimmedString(body.event_location, 200);
      if (!loc) return c.json({ error: 'invalid_event_location' }, 400);
      set('event_location', loc);
    }
  }
  if (body.image_alt_text !== undefined) {
    if (body.image_alt_text === null || body.image_alt_text === '') {
      set('image_alt_text', null);
    } else {
      const alt = asTrimmedString(body.image_alt_text, 500);
      if (!alt) return c.json({ error: 'invalid_image_alt_text' }, 400);
      set('image_alt_text', alt);
    }
  }
  if (body.tags !== undefined) {
    const tags = asStringArray(body.tags);
    if (tags === null) return c.json({ error: 'invalid_tags' }, 400);
    set('tags', JSON.stringify(tags));
  }
  if (body.pdf_r2_key !== undefined) {
    if (body.pdf_r2_key === null) set('pdf_r2_key', null);
    else if (typeof body.pdf_r2_key === 'string' && body.pdf_r2_key.startsWith(`flyers/${id}/`)) {
      set('pdf_r2_key', body.pdf_r2_key);
    } else {
      return c.json({ error: 'invalid_pdf_r2_key' }, 400);
    }
  }
  if (body.image_r2_key !== undefined) {
    if (body.image_r2_key === null) set('image_r2_key', null);
    else if (typeof body.image_r2_key === 'string' && body.image_r2_key.startsWith(`flyers/${id}/`)) {
      set('image_r2_key', body.image_r2_key);
    } else {
      return c.json({ error: 'invalid_image_r2_key' }, 400);
    }
  }

  // Scope/targeting changes go together.
  let scopeUpdate: string | null = null;
  if (body.scope !== undefined) {
    if (typeof body.scope !== 'string' || !SCOPES.has(body.scope)) {
      return c.json({ error: 'invalid_scope' }, 400);
    }
    scopeUpdate = body.scope;
  }
  let schoolsUpdate: string[] | null = null;
  let departmentsUpdate: string[] | null = null;
  if (body.schools !== undefined) {
    schoolsUpdate = asStringArray(body.schools);
    if (schoolsUpdate === null) return c.json({ error: 'invalid_schools' }, 400);
  }
  if (body.departments !== undefined) {
    departmentsUpdate = asStringArray(body.departments);
    if (departmentsUpdate === null) return c.json({ error: 'invalid_departments' }, 400);
  }

  if (scopeUpdate !== null || schoolsUpdate !== null || departmentsUpdate !== null) {
    const finalScope = scopeUpdate ?? row.scope;
    const finalSchools = schoolsUpdate ?? (await loadFlyerTargets(c.env, id)).schools;
    const finalDepts = departmentsUpdate ?? (await loadFlyerTargets(c.env, id)).departments;
    const t = await validateScopeTargets(c.env, finalScope, finalSchools, finalDepts);
    if (!t.ok) return c.json({ error: t.error }, 400);
    if (scopeUpdate !== null) set('scope', scopeUpdate);
    await writeFlyerTargets(c.env, id, finalSchools, finalDepts);
  }

  if (updates.length === 0 && schoolsUpdate === null && departmentsUpdate === null && scopeUpdate === null) {
    return c.json({ error: 'no_changes' }, 400);
  }

  if (updates.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    set('updated_at', now);
    const sql = `UPDATE flyers SET ${updates.join(', ')} WHERE id = ? AND submitted_by = ?`;
    await c.env.DB.prepare(sql)
      .bind(...values, id, user.id)
      .run();
  }

  const updated = await loadFlyerForOwner(c.env, id, user.id);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  const targets = await loadFlyerTargets(c.env, id);
  return c.json({ flyer: flyerToJson(updated, targets) });
});

// ─── POST /api/submitter/flyer/:id/upload ──────────────────────────────────
// Worker-mediated multipart upload. Streams the file to the R2 binding.
// (Per the brief: presigned-URL flow is deferred — for ≤10 MB drafts a
// single Worker hop is operationally simpler than minting S3-style
// signatures, and we avoid issuing R2 access keys.)
//
// Form fields: kind = 'pdf' | 'image', file = the file blob.
api.post('/flyer/:id/upload', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = await loadFlyerForOwner(c.env, id, user.id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status !== 'draft') {
    return c.json({ error: 'not_editable', message: `flyer status is ${row.status}` }, 409);
  }

  const ct = c.req.header('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('multipart/form-data')) {
    return c.json({ error: 'expected_multipart' }, 400);
  }

  const declared = c.req.header('content-length');
  if (declared && parseInt(declared, 10) > MAX_UPLOAD_BYTES * 1.1) {
    return c.json({ error: 'file_too_large', message: 'max 10 MB' }, 413);
  }

  const form = await c.req.parseBody();
  const kindRaw = form.kind;
  const kind = typeof kindRaw === 'string' ? kindRaw : '';
  if (!ALLOWED_UPLOAD_KINDS.has(kind)) {
    return c.json({ error: 'invalid_kind', message: 'kind must be pdf or image' }, 400);
  }

  const file = form.file;
  if (!(file instanceof File)) {
    return c.json({ error: 'no_file' }, 400);
  }
  if (file.size === 0) return c.json({ error: 'empty_file' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ error: 'file_too_large', message: 'max 10 MB' }, 413);
  }

  const fileType = file.type || '';
  if (!ALLOWED_CONTENT_TYPES.has(fileType)) {
    return c.json({ error: 'invalid_content_type', allowed: Array.from(ALLOWED_CONTENT_TYPES) }, 415);
  }
  if (kind === 'pdf' && fileType !== 'application/pdf') {
    return c.json({ error: 'kind_content_type_mismatch' }, 400);
  }
  if (kind === 'image' && fileType === 'application/pdf') {
    return c.json({ error: 'kind_content_type_mismatch' }, 400);
  }

  const ext = EXT_BY_TYPE[fileType];
  const key = `flyers/${id}/${kind}-${ulid()}.${ext}`;

  await c.env.ASSETS.put(key, file.stream(), {
    httpMetadata: { contentType: fileType },
    customMetadata: {
      flyer_id: id,
      uploaded_by: user.id,
      kind,
    },
  });

  const now = Math.floor(Date.now() / 1000);
  if (kind === 'pdf') {
    // Drop any previous PDF object so we don't leak storage on re-upload.
    if (row.pdf_r2_key && row.pdf_r2_key !== key) {
      await c.env.ASSETS.delete(row.pdf_r2_key).catch(() => {});
    }
    await c.env.DB.prepare(
      `UPDATE flyers SET pdf_r2_key = ?, updated_at = ? WHERE id = ? AND submitted_by = ?`,
    )
      .bind(key, now, id, user.id)
      .run();
  } else {
    if (row.image_r2_key && row.image_r2_key !== key) {
      await c.env.ASSETS.delete(row.image_r2_key).catch(() => {});
    }
    await c.env.DB.prepare(
      `UPDATE flyers SET image_r2_key = ?, updated_at = ? WHERE id = ? AND submitted_by = ?`,
    )
      .bind(key, now, id, user.id)
      .run();
  }

  return c.json({
    ok: true,
    kind,
    r2_key: key,
    content_type: fileType,
    size: file.size,
  });
});

// ─── POST /api/submitter/flyer/:id/finalize ────────────────────────────────
api.post('/flyer/:id/finalize', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const row = await loadFlyerForOwner(c.env, id, user.id);
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (row.status !== 'draft') {
    return c.json({ error: 'not_in_draft', message: `flyer status is ${row.status}` }, 409);
  }

  // Pre-finalize sanity: must have either body content OR an uploaded artifact.
  const hasBody = (row.body_plain && row.body_plain.trim().length > 0) ||
                  (row.body_html && row.body_html.trim().length > 0);
  const hasArtifact = !!row.pdf_r2_key || !!row.image_r2_key;
  if (!hasBody && !hasArtifact) {
    return c.json({ error: 'needs_body_or_artifact' }, 400);
  }

  const targets = await loadFlyerTargets(c.env, id);
  const t = await validateScopeTargets(c.env, row.scope, targets.schools, targets.departments);
  if (!t.ok) return c.json({ error: t.error }, 400);

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at <= now) {
    return c.json({ error: 'expires_at_in_past' }, 400);
  }

  // Snapshot current state into flyer_revisions before flipping status.
  const snapshot = JSON.stringify({
    flyer: { ...row },
    targets,
    finalized_at: now,
  });

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO flyer_revisions (flyer_id, version, snapshot, changed_by, changed_at, change_note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, row.version, snapshot, user.id, now, 'finalized for review'),
    c.env.DB.prepare(
      `UPDATE flyers
       SET status = 'submitted', submitted_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND submitted_by = ?`,
    ).bind(now, now, id, user.id),
  ]);

  // §2.3 — AI pipeline runs inline via ctx.waitUntil. Failures are caught
  // inside runAiPipeline and persisted to ai_verdict_json.errors[]; the
  // status will flip to 'ai_review' once steps complete.
  c.executionCtx.waitUntil(
    runAiPipeline(c.env, id).catch((err) => {
      console.error('[ai-pipeline] uncaught error', id, err);
    }),
  );

  return c.json({
    flyer_id: id,
    status: 'submitted',
    submitted_at: now,
    estimated_review_time_hours: 24,
  });
});

export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export default api;
