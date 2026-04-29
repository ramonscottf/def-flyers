// Renders an accessible single-flyer page. Used both as the canonical
// /flyer/:slug page and as the body of the single-flyer email.
//
// WCAG 2.1 AA at launch: semantic landmarks, heading hierarchy, alt text
// always present, contrast known-AA, language attribute, no JS.

export interface FlyerForRender {
  id: string;
  slug: string;
  title: string;
  title_es: string | null;
  summary: string;
  summary_es: string | null;
  body_html: string;
  body_html_es: string | null;
  audience: string;
  scope: string;
  category: string;
  expires_at: number;
  event_start_at: number | null;
  event_end_at: number | null;
  event_location: string | null;
  image_r2_key: string | null;
  image_alt_text: string | null;
  pdf_r2_key: string | null;
  published_at: number | null;
  submitter_email: string | null;
}

export interface RenderOptions {
  language: 'en' | 'es';
  baseUrl: string;
  imageUrl: string | null;
  pdfUrl: string | null;
  schoolNames: string[];
  departmentNames: string[];
}

const STRINGS = {
  en: {
    skipLink: 'Skip to main content',
    eyebrow: 'Davis Education Foundation',
    publishedOn: 'Published',
    audience: 'Audience',
    scope: 'Scope',
    schools: 'Schools',
    departments: 'Departments',
    district: 'District-wide',
    when: 'When',
    where: 'Where',
    expires: 'Expires',
    languageToggle: 'Español',
    languageHref: 'es',
    download: 'Download original PDF',
    fromSubmitter: 'Submitted by',
    footerNote: 'Davis Education Foundation, in partnership with Davis School District',
    audiences: { parents: 'Parents & families', employees: 'DSD employees', both: 'Parents & employees' } as Record<string, string>,
    scopes: { school: 'School', department: 'Department', district: 'District-wide' } as Record<string, string>,
  },
  es: {
    skipLink: 'Saltar al contenido principal',
    eyebrow: 'Fundación Educativa de Davis',
    publishedOn: 'Publicado',
    audience: 'Audiencia',
    scope: 'Alcance',
    schools: 'Escuelas',
    departments: 'Departamentos',
    district: 'A nivel de distrito',
    when: 'Cuándo',
    where: 'Dónde',
    expires: 'Vence',
    languageToggle: 'English',
    languageHref: 'en',
    download: 'Descargar PDF original',
    fromSubmitter: 'Enviado por',
    footerNote: 'Davis Education Foundation, en colaboración con Davis School District',
    audiences: { parents: 'Padres y familias', employees: 'Empleados de DSD', both: 'Padres y empleados' } as Record<string, string>,
    scopes: { school: 'Escuela', department: 'Departamento', district: 'A nivel de distrito' } as Record<string, string>,
  },
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

function fmtDateTime(unix: number, language: 'en' | 'es'): string {
  return new Date(unix * 1000).toLocaleString(language === 'es' ? 'es-US' : 'en-US', {
    timeZone: 'America/Denver',
    dateStyle: 'long',
    timeStyle: 'short',
  });
}

function fmtDate(unix: number, language: 'en' | 'es'): string {
  return new Date(unix * 1000).toLocaleDateString(language === 'es' ? 'es-US' : 'en-US', {
    timeZone: 'America/Denver',
    dateStyle: 'long',
  });
}

export function renderFlyerPage(flyer: FlyerForRender, opts: RenderOptions): string {
  const t = STRINGS[opts.language];
  const titleSrc = opts.language === 'es' ? flyer.title_es ?? flyer.title : flyer.title;
  const summarySrc = opts.language === 'es' ? flyer.summary_es ?? flyer.summary : flyer.summary;
  const bodySrc = opts.language === 'es' ? flyer.body_html_es ?? flyer.body_html : flyer.body_html;

  const targetsBlock =
    flyer.scope === 'school'
      ? `<dt>${t.schools}</dt><dd>${opts.schoolNames.map(escapeHtml).join(', ') || '—'}</dd>`
      : flyer.scope === 'department'
        ? `<dt>${t.departments}</dt><dd>${opts.departmentNames.map(escapeHtml).join(', ') || '—'}</dd>`
        : `<dt>${t.scope}</dt><dd>${t.district}</dd>`;

  const event =
    flyer.event_start_at
      ? `<dt>${t.when}</dt><dd>${escapeHtml(fmtDateTime(flyer.event_start_at, opts.language))}${
          flyer.event_end_at ? ' → ' + escapeHtml(fmtDateTime(flyer.event_end_at, opts.language)) : ''
        }</dd>${
          flyer.event_location
            ? `<dt>${t.where}</dt><dd>${escapeHtml(flyer.event_location)}</dd>`
            : ''
        }`
      : '';

  const heroImage = opts.imageUrl
    ? `<img src="${escapeHtml(opts.imageUrl)}" alt="${escapeHtml(flyer.image_alt_text ?? '')}" class="hero-image" />`
    : '';

  const pdfLink = opts.pdfUrl
    ? `<p class="pdf-link"><a href="${escapeHtml(opts.pdfUrl)}" rel="noreferrer">📄 ${t.download}</a></p>`
    : '';

  const langLink = `${opts.baseUrl}/flyer/${escapeHtml(flyer.slug)}?lang=${t.languageHref}`;

  return `<!DOCTYPE html>
<html lang="${opts.language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(titleSrc)} · DEF Flyers</title>
<meta name="description" content="${escapeHtml(summarySrc)}">
<link rel="canonical" href="${opts.baseUrl}/flyer/${escapeHtml(flyer.slug)}">
<style>
  :root{--navy:#0d1b3d;--navy-2:#1a2a5e;--gold:#c9a13b;--red:#b1252f;--card:#f3f5f9;--ink:#0d1b3d;--ink-2:#4a5876;--rule:#d8dde7}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:#fff;line-height:1.55}
  a{color:var(--navy-2);text-underline-offset:2px}
  a:hover,a:focus{color:var(--red)}
  .skip-link{position:absolute;top:-40px;left:0;background:var(--navy);color:#fff;padding:8px 16px;z-index:100}
  .skip-link:focus{top:0}
  header.bar{background:var(--navy);color:#fff;padding:14px 24px;border-bottom:4px solid;border-image:linear-gradient(90deg,var(--navy-2),var(--red)) 1}
  header.bar .inner{max-width:760px;margin:0 auto;display:flex;align-items:baseline;justify-content:space-between;gap:16px}
  header.bar h1{margin:0;font-size:18px;font-weight:800}
  header.bar a{color:#d6dcec;text-decoration:none}
  main{max-width:760px;margin:32px auto;padding:0 24px 64px}
  article h1{font-size:clamp(28px,5vw,40px);margin:0 0 12px;color:var(--navy);font-weight:800;letter-spacing:-0.02em}
  .lede{font-size:18px;color:var(--ink-2);margin:0 0 20px}
  .hero-image{width:100%;height:auto;border-radius:10px;margin:0 0 24px}
  .meta{display:grid;grid-template-columns:140px 1fr;gap:8px 16px;background:var(--card);border-radius:10px;padding:16px 18px;margin:0 0 24px;font-size:14px}
  .meta dt{font-weight:600;color:var(--ink-2);margin:0}
  .meta dd{margin:0}
  .body{font-size:16px}
  .body h2{font-size:22px;margin:24px 0 8px;color:var(--navy)}
  .body p{margin:0 0 12px}
  .body a{color:var(--navy-2)}
  .pdf-link{margin:24px 0 0;font-size:15px}
  footer{border-top:1px solid var(--rule);padding:20px 24px;text-align:center;color:var(--ink-2);font-size:13px;margin-top:48px}
</style>
</head>
<body>
<a class="skip-link" href="#main">${t.skipLink}</a>
<header class="bar">
  <div class="inner">
    <h1><a href="${opts.baseUrl}/board" lang="en">DEF Flyers</a></h1>
    <a href="${langLink}" lang="${t.languageHref}">${t.languageToggle}</a>
  </div>
</header>
<main id="main">
  <article>
    <p style="margin:0 0 8px;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold);font-weight:600;">${t.eyebrow}</p>
    <h1>${escapeHtml(titleSrc)}</h1>
    <p class="lede">${escapeHtml(summarySrc)}</p>
    ${heroImage}
    <dl class="meta">
      <dt>${t.audience}</dt><dd>${escapeHtml(t.audiences[flyer.audience] ?? flyer.audience)}</dd>
      <dt>${t.scope}</dt><dd>${escapeHtml(t.scopes[flyer.scope] ?? flyer.scope)}</dd>
      ${targetsBlock}
      ${event}
      ${flyer.published_at ? `<dt>${t.publishedOn}</dt><dd>${escapeHtml(fmtDate(flyer.published_at, opts.language))}</dd>` : ''}
      <dt>${t.expires}</dt><dd>${escapeHtml(fmtDate(flyer.expires_at, opts.language))}</dd>
    </dl>
    <div class="body">${bodySrc || ''}</div>
    ${pdfLink}
  </article>
</main>
<footer>${escapeHtml(t.footerNote)}</footer>
</body>
</html>`;
}
