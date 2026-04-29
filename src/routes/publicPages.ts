// Public pages — served without auth.
//
//   GET /flyer/:slug         rendered HTML (from R2), ?lang=es toggle
//   GET /board               flyer board with filters
//   GET /asset?k=flyers/...  public asset proxy for published flyers' images/PDFs
//   GET /unsubscribe?t=...   one-click unsubscribe (subscriber only)

import { Hono } from 'hono';
import type { Bindings } from '../index';

const pages = new Hono<{ Bindings: Bindings }>();

function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function notFound(message = 'Flyer not found.'): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not found · DEF Flyers</title>
<style>body{font-family:system-ui;margin:60px auto;max-width:480px;padding:0 24px;color:#0d1b3d}a{color:#1a2a5e}</style>
</head><body>
<h1>Not found</h1><p>${escapeHtml(message)}</p>
<p><a href="/board">Browse all flyers →</a></p>
</body></html>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

// ─── GET /flyer/:slug ──────────────────────────────────────────────────────
pages.get('/flyer/:slug', async (c) => {
  const slug = c.req.param('slug');
  const lang = c.req.query('lang') === 'es' ? 'es' : 'en';

  // Verify the flyer is actually published before serving the cached HTML.
  const row = await c.env.DB.prepare(
    `SELECT slug, status, expires_at FROM flyers WHERE slug = ?`,
  )
    .bind(slug)
    .first<{ slug: string; status: string; expires_at: number }>();

  if (!row || row.status !== 'published') return notFound();

  const key =
    lang === 'es'
      ? `flyers/${slug}/index.es.html`
      : `flyers/${slug}/index.html`;
  const obj = await c.env.ASSETS.get(key);
  if (!obj) {
    if (lang === 'es') {
      // Fall back to English if the ES variant wasn't rendered.
      const enObj = await c.env.ASSETS.get(`flyers/${slug}/index.html`);
      if (enObj) {
        return new Response(enObj.body, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=300',
            'content-language': 'en',
          },
        });
      }
    }
    return notFound();
  }

  return new Response(obj.body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-language': lang,
    },
  });
});

// ─── GET /asset ────────────────────────────────────────────────────────────
// Public R2 proxy. Only serves keys whose flyer is in status='published'.
// Drafts and pending flyers stay private.
pages.get('/asset', async (c) => {
  const key = c.req.query('k') ?? '';
  if (!key.startsWith('flyers/')) return new Response('forbidden', { status: 403 });

  // Allow only assets of published flyers.
  const cacheKey = `asset:allowed:${key}`;
  let allowed = await c.env.KV.get(cacheKey);
  if (allowed === null) {
    const row = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM flyers
       WHERE status = 'published'
         AND (image_r2_key = ? OR pdf_r2_key = ?)
       LIMIT 1`,
    )
      .bind(key, key)
      .first<{ ok: number }>();
    allowed = row ? '1' : '0';
    await c.env.KV.put(cacheKey, allowed, { expirationTtl: 300 });
  }
  if (allowed !== '1') return new Response('not found', { status: 404 });

  const obj = await c.env.ASSETS.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
      'content-disposition': 'inline',
    },
  });
});

// ─── GET /board ────────────────────────────────────────────────────────────
interface BoardRow {
  id: string;
  slug: string;
  title: string;
  title_es: string | null;
  summary: string;
  summary_es: string | null;
  audience: string;
  scope: string;
  category: string;
  event_start_at: number | null;
  event_end_at: number | null;
  event_location: string | null;
  image_r2_key: string | null;
  image_alt_text: string | null;
  published_at: number | null;
  expires_at: number;
}

pages.get('/board', async (c) => {
  const lang = c.req.query('lang') === 'es' ? 'es' : 'en';
  const audience = c.req.query('audience') ?? '';
  const category = c.req.query('category') ?? '';
  const schoolId = c.req.query('school') ?? '';

  const wheres: string[] = [`f.status = 'published'`, `f.expires_at > unixepoch()`];
  const params: string[] = [];

  if (audience && ['parents', 'employees', 'both'].includes(audience)) {
    wheres.push(`f.audience = ?`);
    params.push(audience);
  }
  if (category) {
    wheres.push(`f.category = ?`);
    params.push(category);
  }

  let join = '';
  if (schoolId) {
    join = `JOIN flyer_schools fs ON fs.flyer_id = f.id`;
    wheres.push(`fs.school_id = ?`);
    params.push(schoolId);
  }

  const sql = `
    SELECT DISTINCT f.id, f.slug, f.title, f.title_es, f.summary, f.summary_es,
           f.audience, f.scope, f.category,
           f.event_start_at, f.event_end_at, f.event_location,
           f.image_r2_key, f.image_alt_text,
           f.published_at, f.expires_at
    FROM flyers f
    ${join}
    WHERE ${wheres.join(' AND ')}
    ORDER BY f.published_at DESC
    LIMIT 50
  `;
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<BoardRow>();

  const baseUrl = c.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const t = lang === 'es' ? STRINGS.es : STRINGS.en;

  const cards = results
    .map((r) => {
      const title = lang === 'es' ? r.title_es ?? r.title : r.title;
      const summary = lang === 'es' ? r.summary_es ?? r.summary : r.summary;
      const img = r.image_r2_key
        ? `<img src="${baseUrl}/asset?k=${encodeURIComponent(r.image_r2_key)}" alt="${escapeHtml(r.image_alt_text ?? '')}" loading="lazy">`
        : '';
      const event = r.event_start_at
        ? `<p class="event">${escapeHtml(new Date(r.event_start_at * 1000).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
            timeZone: 'America/Denver',
            dateStyle: 'medium',
          }))}${r.event_location ? ' · ' + escapeHtml(r.event_location) : ''}</p>`
        : '';
      return `<li class="card">
        <a href="/flyer/${escapeHtml(r.slug)}${lang === 'es' ? '?lang=es' : ''}">
          ${img}
          <h2>${escapeHtml(title)}</h2>
          <p class="summary">${escapeHtml(summary)}</p>
          ${event}
          <p class="meta">${escapeHtml(r.audience)} · ${escapeHtml(r.scope)} · ${escapeHtml(r.category)}</p>
        </a>
      </li>`;
    })
    .join('');

  const empty = `<p class="empty">${escapeHtml(t.empty)}</p>`;

  return c.html(`<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(t.title)} · DEF Flyers</title>
<meta name="description" content="${escapeHtml(t.description)}">
<style>
  :root{--navy:#0d1b3d;--navy-2:#1a2a5e;--gold:#c9a13b;--red:#b1252f;--card:#f3f5f9;--ink:#0d1b3d;--ink-2:#4a5876;--rule:#d8dde7}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:#fff;line-height:1.55}
  a{color:var(--navy-2);text-underline-offset:2px}
  a:hover,a:focus{color:var(--red)}
  .skip-link{position:absolute;top:-40px;left:0;background:var(--navy);color:#fff;padding:8px 16px;z-index:100}
  .skip-link:focus{top:0}
  header.bar{background:var(--navy);color:#fff;padding:14px 24px;border-bottom:4px solid;border-image:linear-gradient(90deg,var(--navy-2),var(--red)) 1}
  header.bar .inner{max-width:1100px;margin:0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:16px}
  header.bar h1{margin:0;font-size:18px;font-weight:800}
  header.bar a{color:#d6dcec;text-decoration:none}
  main{max-width:1100px;margin:32px auto;padding:0 24px 64px}
  h2.page{font-size:28px;margin:0 0 12px;color:var(--navy)}
  ul.cards{list-style:none;padding:0;margin:24px 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
  li.card{background:var(--card);border-radius:10px;overflow:hidden;transition:transform .15s ease}
  li.card:focus-within,li.card:hover{transform:translateY(-1px)}
  li.card a{display:block;padding:16px;color:inherit;text-decoration:none}
  li.card img{display:block;width:calc(100% + 32px);margin:-16px -16px 12px;height:160px;object-fit:cover;background:#fff}
  li.card h2{margin:0 0 6px;font-size:18px;color:var(--navy)}
  li.card .summary{margin:0 0 8px;font-size:14px;color:var(--ink-2)}
  li.card .event{margin:0 0 6px;font-size:13px;color:var(--navy-2);font-weight:600}
  li.card .meta{margin:0;font-size:12px;color:var(--ink-2);text-transform:uppercase;letter-spacing:0.04em}
  .filters{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 8px;font-size:14px;color:var(--ink-2)}
  .filters a{color:var(--navy-2);text-decoration:underline}
  .empty{padding:48px 16px;text-align:center;color:var(--ink-2);background:var(--card);border-radius:10px}
  footer{border-top:1px solid var(--rule);padding:20px 24px;text-align:center;color:var(--ink-2);font-size:13px;margin-top:48px}
</style>
</head>
<body>
<a class="skip-link" href="#main">${escapeHtml(t.skipLink)}</a>
<header class="bar"><div class="inner">
  <h1><a href="/board">DEF Flyers</a></h1>
  <a href="/board?lang=${lang === 'es' ? 'en' : 'es'}">${lang === 'es' ? 'English' : 'Español'}</a>
</div></header>
<main id="main">
  <h2 class="page">${escapeHtml(t.title)}</h2>
  <p style="color:var(--ink-2);margin:0 0 16px;">${escapeHtml(t.description)}</p>
  ${results.length > 0 ? `<ul class="cards">${cards}</ul>` : empty}
</main>
<footer>${escapeHtml(t.footer)}</footer>
</body></html>`);
});

const STRINGS = {
  en: {
    title: 'Flyer board',
    description: 'Community flyers and district announcements for Davis School District.',
    empty: 'No flyers published yet.',
    skipLink: 'Skip to main content',
    footer: 'Davis Education Foundation, in partnership with Davis School District',
  },
  es: {
    title: 'Tablero de folletos',
    description: 'Folletos comunitarios y anuncios del distrito para Davis School District.',
    empty: 'Todavía no hay folletos publicados.',
    skipLink: 'Saltar al contenido principal',
    footer: 'Davis Education Foundation, en colaboración con Davis School District',
  },
} as const;

export default pages;
