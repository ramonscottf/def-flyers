// Publish flow: render → write to R2 → flip status → fan out to subscribers.
// Called inline (via ctx.waitUntil) on approve, and on the cron tick for any
// row whose scheduled_send_at has passed.

import type { Bindings } from '../index';
import { renderFlyerPage, type FlyerForRender } from './render';
import { renderFlyerSingleEmail } from '../email/templates/flyerSingle';
import { getTransactionalSender } from '../lib/email';

interface FlyerRow extends FlyerForRender {
  status: string;
  version: number;
  body_plain: string;
}

interface SubscriberRow {
  id: number;
  email: string;
  audience: string;
  school_ids: string | null;
  language: string | null;
  unsubscribe_token: string;
}

const PAGE_PREFIX = 'flyers';

function pageKey(slug: string, language: 'en' | 'es'): string {
  return language === 'es' ? `${PAGE_PREFIX}/${slug}/index.es.html` : `${PAGE_PREFIX}/${slug}/index.html`;
}

async function loadFlyerWithSubmitter(env: Bindings, flyerId: string): Promise<FlyerRow | null> {
  return await env.DB.prepare(
    `SELECT f.id, f.slug, f.title, f.title_es, f.summary, f.summary_es,
            f.body_html, f.body_html_es, f.body_plain,
            f.audience, f.scope, f.category, f.expires_at,
            f.event_start_at, f.event_end_at, f.event_location,
            f.image_r2_key, f.image_alt_text, f.pdf_r2_key,
            f.status, f.version, f.published_at,
            u.email AS submitter_email
     FROM flyers f LEFT JOIN users u ON u.id = f.submitted_by
     WHERE f.id = ?`,
  )
    .bind(flyerId)
    .first<FlyerRow>();
}

async function loadTargets(
  env: Bindings,
  flyerId: string,
): Promise<{ schoolIds: string[]; schoolNames: string[]; departmentIds: string[]; departmentNames: string[] }> {
  const [schools, departments] = await Promise.all([
    env.DB.prepare(
      `SELECT s.id, s.name FROM flyer_schools fs JOIN schools s ON s.id = fs.school_id WHERE fs.flyer_id = ?`,
    )
      .bind(flyerId)
      .all<{ id: string; name: string }>(),
    env.DB.prepare(
      `SELECT d.id, d.name FROM flyer_departments fd JOIN departments d ON d.id = fd.department_id WHERE fd.flyer_id = ?`,
    )
      .bind(flyerId)
      .all<{ id: string; name: string }>(),
  ]);
  return {
    schoolIds: schools.results.map((r) => r.id),
    schoolNames: schools.results.map((r) => r.name),
    departmentIds: departments.results.map((r) => r.id),
    departmentNames: departments.results.map((r) => r.name),
  };
}

async function writeRenderedHtmlToR2(
  env: Bindings,
  flyer: FlyerRow,
  targets: { schoolNames: string[]; departmentNames: string[] },
): Promise<void> {
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const imageUrl = flyer.image_r2_key ? `${baseUrl}/asset?k=${encodeURIComponent(flyer.image_r2_key)}` : null;
  const pdfUrl = flyer.pdf_r2_key ? `${baseUrl}/asset?k=${encodeURIComponent(flyer.pdf_r2_key)}` : null;

  const en = renderFlyerPage(flyer, {
    language: 'en',
    baseUrl,
    imageUrl,
    pdfUrl,
    schoolNames: targets.schoolNames,
    departmentNames: targets.departmentNames,
  });

  await env.ASSETS.put(pageKey(flyer.slug, 'en'), en, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });

  // ES variant only renders if any ES content is available; otherwise we
  // fall through (the page renders English fallback strings).
  if (flyer.title_es || flyer.summary_es || flyer.body_html_es) {
    const es = renderFlyerPage(flyer, {
      language: 'es',
      baseUrl,
      imageUrl,
      pdfUrl,
      schoolNames: targets.schoolNames,
      departmentNames: targets.departmentNames,
    });
    await env.ASSETS.put(pageKey(flyer.slug, 'es'), es, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
  }
}

interface MatchedSubscriber {
  row: SubscriberRow;
  language: 'en' | 'es';
}

async function findMatchingSubscribers(
  env: Bindings,
  flyer: FlyerRow,
  schoolIds: string[],
): Promise<MatchedSubscriber[]> {
  // Step 1: pull all active+verified subscribers whose audience matches and
  // who aren't on the email suppression list.
  // Volume is low at launch, so post-filter the JSON school overlap in JS
  // rather than wrestling with json_each + dynamic IN lists.
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.email, s.audience, s.school_ids, s.language, s.unsubscribe_token
     FROM subscriptions s
     WHERE s.active = 1 AND s.verified = 1
       AND (s.audience = ? OR s.audience = 'both' OR ? = 'both')
       AND NOT EXISTS (
         SELECT 1 FROM suppressions sp
         WHERE sp.channel = 'email' AND sp.identifier = s.email
       )`,
  )
    .bind(flyer.audience, flyer.audience)
    .all<SubscriberRow>();

  const matched: MatchedSubscriber[] = [];

  for (const sub of results) {
    if (flyer.scope === 'school') {
      const wanted = parseSchoolIds(sub.school_ids);
      // No subscribed schools = subscriber wants everything in their audience.
      const overlap = wanted.length === 0 || wanted.some((id) => schoolIds.includes(id));
      if (!overlap) continue;
    }
    // For department/district scope: any matching audience is enough.

    matched.push({
      row: sub,
      language: sub.language === 'es' ? 'es' : 'en',
    });
  }

  return matched;
}

function parseSchoolIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function fmtDateTimeMT(unix: number, language: 'en' | 'es'): string {
  return new Date(unix * 1000).toLocaleString(language === 'es' ? 'es-US' : 'en-US', {
    timeZone: 'America/Denver',
    dateStyle: 'long',
    timeStyle: 'short',
  });
}

function fmtDateMT(unix: number, language: 'en' | 'es'): string {
  return new Date(unix * 1000).toLocaleDateString(language === 'es' ? 'es-US' : 'en-US', {
    timeZone: 'America/Denver',
    dateStyle: 'long',
  });
}

async function fanOutEmails(
  env: Bindings,
  flyer: FlyerRow,
  matched: MatchedSubscriber[],
  ctx?: ExecutionContext,
): Promise<{ queued: number; failed: number }> {
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const imageUrl = flyer.image_r2_key ? `${baseUrl}/asset?k=${encodeURIComponent(flyer.image_r2_key)}` : null;

  const sender = getTransactionalSender(env);

  let queued = 0;
  let failed = 0;

  for (const m of matched) {
    const language = m.language;
    const flyerUrl = `${baseUrl}/flyer/${flyer.slug}${language === 'es' ? '?lang=es' : ''}`;
    const unsubscribeUrl = `${baseUrl}/unsubscribe?t=${encodeURIComponent(m.row.unsubscribe_token)}`;
    const eventLine = flyer.event_start_at
      ? `${language === 'es' ? 'Cuándo:' : 'When:'} ${fmtDateTimeMT(flyer.event_start_at, language)}${
          flyer.event_location ? ` · ${flyer.event_location}` : ''
        }`
      : null;

    const { subject, html, text } = renderFlyerSingleEmail({
      title: language === 'es' ? flyer.title_es ?? flyer.title : flyer.title,
      summary: language === 'es' ? flyer.summary_es ?? flyer.summary : flyer.summary,
      bodyHtml: language === 'es' ? flyer.body_html_es ?? flyer.body_html : flyer.body_html,
      flyerUrl,
      unsubscribeUrl,
      imageUrl,
      imageAlt: flyer.image_alt_text,
      language,
      eventLine,
      expires: fmtDateMT(flyer.expires_at, language),
      baseUrl,
    });

    // Insert the deliveries row first so we have a paper trail even if the
    // network call dies mid-way. Provider id gets filled in async.
    let deliveryId: number | null = null;
    try {
      const ins = await env.DB.prepare(
        `INSERT INTO deliveries (subscription_id, flyer_id, channel, recipient, subject, status)
         VALUES (?, ?, 'email', ?, ?, 'queued')`,
      )
        .bind(m.row.id, flyer.id, m.row.email, subject)
        .run();
      deliveryId = ins.meta.last_row_id ?? null;
    } catch (err) {
      console.error('[publish] deliveries insert failed', err);
      failed++;
      continue;
    }

    const send = async () => {
      try {
        const r = await sender.send({
          to: m.row.email,
          subject,
          html,
          text,
          tag: 'flyer-single',
        });
        const now = Math.floor(Date.now() / 1000);
        if (deliveryId !== null) {
          await env.DB.prepare(
            `UPDATE deliveries SET status = 'sent', provider_message_id = ?, sent_at = ? WHERE id = ?`,
          )
            .bind(r.id, now, deliveryId)
            .run();
        }
      } catch (err) {
        console.error('[publish] email send failed', err);
        if (deliveryId !== null) {
          await env.DB.prepare(`UPDATE deliveries SET status = 'failed', error = ? WHERE id = ?`)
            .bind(String(err).slice(0, 500), deliveryId)
            .run();
        }
        failed++;
      }
    };

    if (ctx) ctx.waitUntil(send());
    else await send();
    queued++;
  }

  return { queued, failed };
}

export async function publishFlyer(
  env: Bindings,
  flyerId: string,
  ctx?: ExecutionContext,
): Promise<{ ok: boolean; published_at?: number; queued?: number; reason?: string }> {
  const flyer = await loadFlyerWithSubmitter(env, flyerId);
  if (!flyer) return { ok: false, reason: 'not_found' };
  if (!['approved', 'scheduled'].includes(flyer.status)) {
    return { ok: false, reason: `wrong_status:${flyer.status}` };
  }

  const targets = await loadTargets(env, flyerId);

  // Render + write HTML to R2.
  await writeRenderedHtmlToR2(env, flyer, targets);

  // Flip status to published *before* fan-out so a slow send doesn't block
  // the public page from being live.
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE flyers SET status = 'published', published_at = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  )
    .bind(now, now, flyerId)
    .run();

  const matched = await findMatchingSubscribers(env, flyer, targets.schoolIds);
  const result = await fanOutEmails(env, flyer, matched, ctx);

  return { ok: true, published_at: now, queued: result.queued };
}

export async function runScheduledPublishes(env: Bindings): Promise<{ checked: number; published: number }> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(
    `SELECT id FROM flyers WHERE status = 'scheduled' AND scheduled_send_at IS NOT NULL AND scheduled_send_at <= ?
     ORDER BY scheduled_send_at ASC LIMIT 50`,
  )
    .bind(now)
    .all<{ id: string }>();

  let published = 0;
  for (const row of results) {
    const r = await publishFlyer(env, row.id);
    if (r.ok) published++;
  }
  return { checked: results.length, published };
}
