// AI pipeline orchestrator.
// Phase 1 runs inline via ctx.waitUntil — Cloudflare Queues come in
// Phase 2 if volume warrants. Each step is best-effort: a failure in one
// step is recorded in ai_verdict_json.errors[] but does not abort the rest.
//
// Steps, in order:
//   1. Extraction (Sonnet vision) — only if pdf_r2_key or image_r2_key set
//   2. Alt text (Sonnet vision) — only if image_r2_key set
//   3. Translation (Haiku) — title, summary, body_html
//   4. Moderation (Haiku) — verdict + flags
//   5. Contrast (no AI) — WCAG luminance over inline colour pairs

import type { Bindings } from '../index';
import {
  callAnthropic,
  estimateCostUsd,
  extractJsonBlock,
  MissingApiKeyError,
  MODEL_HAIKU,
  MODEL_SONNET,
} from './client';
import {
  ALT_TEXT_SYSTEM,
  ALT_TEXT_USER,
  EXTRACT_SYSTEM,
  EXTRACT_USER_TEXT,
  MODERATE_SYSTEM,
  PROMPT_VERSION,
  TRANSLATE_SYSTEM,
  moderateUserPrompt,
  translateUserPrompt,
} from './prompts';
import { inspectInlineColors } from './contrast';

export interface PipelineFlyerRow {
  id: string;
  title: string;
  summary: string;
  body_html: string;
  body_plain: string;
  category: string;
  audience: string;
  scope: string;
  image_r2_key: string | null;
  pdf_r2_key: string | null;
  image_alt_text: string | null;
  version: number;
}

export interface PipelineVerdict {
  prompt_version: string;
  cost_usd: number;
  steps: {
    extraction?: { ran: boolean; has_image_of_text?: boolean; event_data?: unknown; chars?: number; error?: string };
    alt_text?: { ran: boolean; alt_text?: string; error?: string };
    translation?: { ran: boolean; error?: string };
    moderation?: { ran: boolean; verdict?: 'green' | 'yellow' | 'red'; flags?: string[]; reasons?: string[]; error?: string };
    contrast?: { ran: boolean; min_ratio?: number; passed?: boolean; findings_count?: number; note?: string; error?: string };
  };
  errors: string[];
}

const COST_WARN_THRESHOLD_USD = 0.2;

interface BuiltUpdates {
  set: string[];
  values: (string | number | null)[];
}

function pushSet(b: BuiltUpdates, col: string, val: string | number | null) {
  b.set.push(`${col} = ?`);
  b.values.push(val);
}

async function readR2AsBase64(env: Bindings, key: string): Promise<{ base64: string; type: string } | null> {
  const obj = await env.ASSETS.get(key);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  // Chunked to avoid stack issues with apply on big arrays.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  const base64 = btoa(bin);
  const type = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  return { base64, type };
}

interface ExtractionPayload {
  has_image_of_text: boolean;
  extracted_text: string;
  event_data: Record<string, unknown>;
}

async function runExtraction(
  env: Bindings,
  flyer: PipelineFlyerRow,
): Promise<{ ran: true; result: ExtractionPayload | null; cost: number; error?: string } | { ran: false }> {
  const key = flyer.pdf_r2_key ?? flyer.image_r2_key;
  if (!key) return { ran: false };

  try {
    const blob = await readR2AsBase64(env, key);
    if (!blob) return { ran: true, result: null, cost: 0, error: 'r2_object_missing' };

    const isPdf = blob.type === 'application/pdf';
    const block = isPdf
      ? {
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: 'application/pdf' as const,
            data: blob.base64,
          },
        }
      : {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: blob.type, data: blob.base64 },
        };

    const resp = await callAnthropic(env, {
      model: MODEL_SONNET,
      system: EXTRACT_SYSTEM,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [block, { type: 'text', text: EXTRACT_USER_TEXT }],
        },
      ],
    });

    const cost = estimateCostUsd(MODEL_SONNET, resp.usage);
    let parsed: ExtractionPayload | null = null;
    try {
      parsed = JSON.parse(extractJsonBlock(resp.text));
    } catch {
      return { ran: true, result: null, cost, error: 'extract_json_parse_failed' };
    }
    return { ran: true, result: parsed, cost };
  } catch (err) {
    return { ran: true, result: null, cost: 0, error: errorMessage(err) };
  }
}

async function runAltText(
  env: Bindings,
  flyer: PipelineFlyerRow,
): Promise<{ ran: true; alt_text: string | null; cost: number; error?: string } | { ran: false }> {
  if (!flyer.image_r2_key) return { ran: false };

  try {
    const blob = await readR2AsBase64(env, flyer.image_r2_key);
    if (!blob) return { ran: true, alt_text: null, cost: 0, error: 'r2_object_missing' };
    if (blob.type === 'application/pdf') return { ran: false };

    const resp = await callAnthropic(env, {
      model: MODEL_SONNET,
      system: ALT_TEXT_SYSTEM,
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: blob.type, data: blob.base64 } },
            { type: 'text', text: ALT_TEXT_USER },
          ],
        },
      ],
    });

    const text = resp.text.trim().replace(/^["']|["']$/g, '');
    return { ran: true, alt_text: text || null, cost: estimateCostUsd(MODEL_SONNET, resp.usage) };
  } catch (err) {
    return { ran: true, alt_text: null, cost: 0, error: errorMessage(err) };
  }
}

async function runTranslation(
  env: Bindings,
  flyer: PipelineFlyerRow,
): Promise<{ title?: string; summary?: string; body_html?: string; cost: number; error?: string }> {
  const out: { title?: string; summary?: string; body_html?: string; cost: number; error?: string } = { cost: 0 };

  async function translate(input: { kind: 'text' | 'html'; text: string }): Promise<{ text: string; cost: number }> {
    const resp = await callAnthropic(env, {
      model: MODEL_HAIKU,
      system: TRANSLATE_SYSTEM,
      max_tokens: 2048,
      messages: [{ role: 'user', content: [{ type: 'text', text: translateUserPrompt(input) }] }],
    });
    return { text: resp.text.trim(), cost: estimateCostUsd(MODEL_HAIKU, resp.usage) };
  }

  try {
    if (flyer.title) {
      const r = await translate({ kind: 'text', text: flyer.title });
      out.title = r.text;
      out.cost += r.cost;
    }
    if (flyer.summary) {
      const r = await translate({ kind: 'text', text: flyer.summary });
      out.summary = r.text;
      out.cost += r.cost;
    }
    if (flyer.body_html && flyer.body_html.trim().length > 0) {
      const r = await translate({ kind: 'html', text: flyer.body_html });
      out.body_html = r.text;
      out.cost += r.cost;
    }
  } catch (err) {
    out.error = errorMessage(err);
  }
  return out;
}

interface ModerationPayload {
  verdict: 'green' | 'yellow' | 'red';
  flags: string[];
  reasons: string[];
}

async function runModeration(
  env: Bindings,
  flyer: PipelineFlyerRow,
): Promise<{ ran: true; result: ModerationPayload | null; cost: number; error?: string }> {
  try {
    const resp = await callAnthropic(env, {
      model: MODEL_HAIKU,
      system: MODERATE_SYSTEM,
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: moderateUserPrompt({
                title: flyer.title,
                summary: flyer.summary,
                body_plain: flyer.body_plain,
                category: flyer.category,
                audience: flyer.audience,
                scope: flyer.scope,
              }),
            },
          ],
        },
      ],
    });

    const cost = estimateCostUsd(MODEL_HAIKU, resp.usage);
    let parsed: ModerationPayload | null = null;
    try {
      parsed = JSON.parse(extractJsonBlock(resp.text));
    } catch {
      return { ran: true, result: null, cost, error: 'moderate_json_parse_failed' };
    }
    if (!parsed || !['green', 'yellow', 'red'].includes(parsed.verdict)) {
      return { ran: true, result: null, cost, error: 'moderate_invalid_verdict' };
    }
    return { ran: true, result: parsed, cost };
  } catch (err) {
    return { ran: true, result: null, cost: 0, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof MissingApiKeyError) return 'missing_anthropic_key';
  if (err instanceof Error) return err.message.slice(0, 300);
  return 'unknown_error';
}

export async function runAiPipeline(env: Bindings, flyerId: string): Promise<void> {
  const flyer = await env.DB.prepare(
    `SELECT id, title, summary, body_html, body_plain, category, audience, scope,
            image_r2_key, pdf_r2_key, image_alt_text, version
     FROM flyers WHERE id = ?`,
  )
    .bind(flyerId)
    .first<PipelineFlyerRow>();

  if (!flyer) {
    console.error('[ai-pipeline] flyer not found', flyerId);
    return;
  }

  const verdict: PipelineVerdict = {
    prompt_version: PROMPT_VERSION,
    cost_usd: 0,
    steps: {},
    errors: [],
  };
  const updates: BuiltUpdates = { set: [], values: [] };

  // ─── Step 1: extraction ──────────────────────────────────────────────
  const extraction = await runExtraction(env, flyer);
  if (extraction.ran) {
    verdict.cost_usd += extraction.cost ?? 0;
    if (extraction.error) verdict.errors.push(`extraction:${extraction.error}`);
    if (extraction.result) {
      verdict.steps.extraction = {
        ran: true,
        has_image_of_text: !!extraction.result.has_image_of_text,
        event_data: extraction.result.event_data,
        chars: extraction.result.extracted_text?.length ?? 0,
      };
      // If body content is empty AND the document is image-of-text, fill in from extraction.
      const hasBody = (flyer.body_plain && flyer.body_plain.trim().length > 0) ||
                      (flyer.body_html && flyer.body_html.trim().length > 0);
      if (extraction.result.has_image_of_text && !hasBody && extraction.result.extracted_text) {
        const newPlain = extraction.result.extracted_text;
        const newHtml = newPlain
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
          .join('\n');
        flyer.body_plain = newPlain;
        flyer.body_html = newHtml;
        pushSet(updates, 'body_plain', newPlain);
        pushSet(updates, 'body_html', newHtml);
      }
    } else {
      verdict.steps.extraction = { ran: true, error: extraction.error };
    }
  } else {
    verdict.steps.extraction = { ran: false };
  }

  // ─── Step 2: alt text ────────────────────────────────────────────────
  const alt = await runAltText(env, flyer);
  if (alt.ran) {
    verdict.cost_usd += alt.cost ?? 0;
    if (alt.error) verdict.errors.push(`alt_text:${alt.error}`);
    verdict.steps.alt_text = { ran: true, alt_text: alt.alt_text ?? undefined, error: alt.error };
    if (alt.alt_text && !flyer.image_alt_text) {
      pushSet(updates, 'image_alt_text', alt.alt_text);
    }
  } else {
    verdict.steps.alt_text = { ran: false };
  }

  // ─── Step 3: translation ─────────────────────────────────────────────
  const tr = await runTranslation(env, flyer);
  verdict.cost_usd += tr.cost;
  if (tr.error) verdict.errors.push(`translation:${tr.error}`);
  verdict.steps.translation = { ran: !tr.error };
  if (tr.title) pushSet(updates, 'title_es', tr.title);
  if (tr.summary) pushSet(updates, 'summary_es', tr.summary);
  if (tr.body_html) pushSet(updates, 'body_html_es', tr.body_html);

  // ─── Step 4: moderation ──────────────────────────────────────────────
  const mod = await runModeration(env, flyer);
  verdict.cost_usd += mod.cost ?? 0;
  if (mod.error) verdict.errors.push(`moderation:${mod.error}`);
  verdict.steps.moderation = mod.result
    ? { ran: true, verdict: mod.result.verdict, flags: mod.result.flags, reasons: mod.result.reasons }
    : { ran: true, error: mod.error };

  // ─── Step 5: contrast ────────────────────────────────────────────────
  try {
    const c = inspectInlineColors(flyer.body_html);
    verdict.steps.contrast = {
      ran: true,
      min_ratio: c.min_ratio,
      passed: c.passed,
      findings_count: c.inspected_pairs,
      note: c.note,
    };
    // accessibility_audits row for the reviewer.
    await env.DB.prepare(
      `INSERT INTO accessibility_audits (flyer_id, audit_type, score, passed, findings, audited_at, audited_version)
       VALUES (?, 'contrast', ?, ?, ?, ?, ?)`,
    )
      .bind(
        flyerId,
        Math.min(100, Math.round(c.min_ratio * 5)), // crude 0-100 mapping
        c.passed ? 1 : 0,
        JSON.stringify(c),
        Math.floor(Date.now() / 1000),
        flyer.version,
      )
      .run();
  } catch (err) {
    verdict.steps.contrast = { ran: true, error: errorMessage(err) };
    verdict.errors.push(`contrast:${errorMessage(err)}`);
  }

  // ─── Persist verdict + status flip ───────────────────────────────────
  pushSet(updates, 'ai_verdict_json', JSON.stringify(verdict));
  pushSet(updates, 'prompt_version', PROMPT_VERSION);
  pushSet(updates, 'ai_processed_at', Math.floor(Date.now() / 1000));
  pushSet(updates, 'status', 'ai_review');
  pushSet(updates, 'updated_at', Math.floor(Date.now() / 1000));

  const sql = `UPDATE flyers SET ${updates.set.join(', ')} WHERE id = ?`;
  await env.DB.prepare(sql)
    .bind(...updates.values, flyerId)
    .run();

  if (verdict.cost_usd > COST_WARN_THRESHOLD_USD) {
    console.warn(
      `[ai-pipeline] cost ${verdict.cost_usd.toFixed(3)} USD exceeded threshold ${COST_WARN_THRESHOLD_USD} for flyer ${flyerId}`,
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
