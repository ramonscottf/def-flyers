import { Hono } from 'hono';
import type { Bindings } from '../index';

const api = new Hono<{ Bindings: Bindings }>();

// ─── /api/public/schools ─────────────────────────────────────────────────
api.get('/schools', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT id, name, short_name, level, website
    FROM schools
    WHERE active = 1
    ORDER BY
      CASE level
        WHEN 'district' THEN 0
        WHEN 'high' THEN 1
        WHEN 'junior' THEN 2
        WHEN 'elementary' THEN 3
        ELSE 4
      END,
      name
  `).all();
  return c.json({ schools: results });
});

// ─── /api/public/departments ─────────────────────────────────────────────
api.get('/departments', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT id, name, description
    FROM departments
    WHERE active = 1
    ORDER BY name
  `).all();
  return c.json({ departments: results });
});

// ─── /api/public/feed ────────────────────────────────────────────────────
// Published flyers, optional filters: ?school=, ?audience=, ?category=
api.get('/feed', async (c) => {
  const school = c.req.query('school');
  const audience = c.req.query('audience'); // parents|employees
  const category = c.req.query('category');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);

  const wheres: string[] = [
    `f.status = 'published'`,
    `f.expires_at > unixepoch()`,
  ];
  const params: (string | number)[] = [];

  if (audience) {
    wheres.push(`f.audience = ?`);
    params.push(audience);
  }
  if (category) {
    wheres.push(`f.category = ?`);
    params.push(category);
  }

  let join = '';
  if (school) {
    join = `JOIN flyer_schools fs ON fs.flyer_id = f.id`;
    wheres.push(`fs.school_id = ?`);
    params.push(school);
  }

  const sql = `
    SELECT DISTINCT
      f.id, f.slug, f.title, f.summary, f.audience, f.category,
      f.event_start_at, f.event_end_at, f.event_location,
      f.image_r2_key, f.image_alt_text,
      f.published_at, f.expires_at
    FROM flyers f
    ${join}
    WHERE ${wheres.join(' AND ')}
    ORDER BY f.published_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const stmt = c.env.DB.prepare(sql);
  for (const p of params) stmt.bind(p); // no-op, see next line
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ flyers: results, count: results.length });
});

export default api;
