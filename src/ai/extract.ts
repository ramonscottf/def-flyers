// AI-driven structured extraction at upload time.
// Used by the submitter wizard's "Quick start from a PDF" flow:
//   user uploads a PDF/image → this returns the structured fields
//   pre-filled in the new-flyer form.
//
// Distinct from the post-finalize pipeline extraction step, which uses
// EXTRACT_SYSTEM and runs against an already-saved flyer.

import type { Bindings } from '../index';
import {
  callAnthropic,
  estimateCostUsd,
  extractJsonBlock,
  MissingApiKeyError,
  MODEL_SONNET,
} from './client';
import { FLYER_EXTRACT_SYSTEM, flyerExtractUserPrompt } from './prompts';

export interface ExtractedFlyer {
  title: string;
  summary: string;
  audience: 'parents' | 'employees' | 'both';
  scope: 'school' | 'department' | 'district';
  school_ids: string[];
  department_ids: string[];
  category: string;
  body_plain: string;
  image_alt_text: string | null;
  event_start_iso: string | null;
  event_end_iso: string | null;
  event_location: string | null;
  expires_at_iso: string | null;
  has_image_of_text: boolean;
  confidence: number;
}

export type ExtractError =
  | 'missing_anthropic_key'
  | 'anthropic_quota'
  | 'anthropic_error'
  | 'parse_failed'
  | 'invalid_response_shape';

export interface ExtractResult {
  data: ExtractedFlyer;
  cost_usd: number;
  raw_text: string;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string');
}
function asEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export async function extractFlyerFromUpload(
  env: Bindings,
  blob: { base64: string; type: string },
  schools: { id: string; name: string; level: string }[],
  departments: { id: string; name: string }[],
): Promise<{ ok: true; result: ExtractResult } | { ok: false; error: ExtractError; detail?: string }> {
  const isPdf = blob.type === 'application/pdf';
  const docBlock = isPdf
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

  let resp;
  try {
    resp = await callAnthropic(env, {
      model: MODEL_SONNET,
      system: FLYER_EXTRACT_SYSTEM,
      max_tokens: 3000,
      messages: [
        {
          role: 'user',
          content: [docBlock, { type: 'text', text: flyerExtractUserPrompt(schools, departments) }],
        },
      ],
    });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return { ok: false, error: 'missing_anthropic_key' };
    }
    const msg = err instanceof Error ? err.message : 'unknown';
    if (/usage limits|429|quota/i.test(msg)) {
      return { ok: false, error: 'anthropic_quota', detail: msg.slice(0, 300) };
    }
    return { ok: false, error: 'anthropic_error', detail: msg.slice(0, 300) };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJsonBlock(resp.text));
  } catch {
    return { ok: false, error: 'parse_failed', detail: resp.text.slice(0, 300) };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'invalid_response_shape' };
  }

  const validSchoolIds = new Set(schools.map((s) => s.id));
  const validDeptIds = new Set(departments.map((d) => d.id));

  const data: ExtractedFlyer = {
    title: asString(parsed.title).trim().slice(0, 200),
    summary: asString(parsed.summary).trim().slice(0, 500),
    audience: asEnum(parsed.audience, ['parents', 'employees', 'both'] as const, 'parents'),
    scope: asEnum(parsed.scope, ['school', 'department', 'district'] as const, 'school'),
    school_ids: asStringArray(parsed.school_ids).filter((id) => validSchoolIds.has(id)),
    department_ids: asStringArray(parsed.department_ids).filter((id) => validDeptIds.has(id)),
    category: asString(parsed.category).trim().slice(0, 100) || 'Community Event',
    body_plain: asString(parsed.body_plain).trim(),
    image_alt_text: asStringOrNull(parsed.image_alt_text),
    event_start_iso: asStringOrNull(parsed.event_start_iso),
    event_end_iso: asStringOrNull(parsed.event_end_iso),
    event_location: asStringOrNull(parsed.event_location),
    expires_at_iso: asStringOrNull(parsed.expires_at_iso),
    has_image_of_text: asBool(parsed.has_image_of_text),
    confidence: Math.min(1, Math.max(0, asNumber(parsed.confidence, 0.5))),
  };

  // Defensive: if AI picked a scope but didn't supply matching targets, drop
  // back to a manageable default so the form renders sensibly.
  if (data.scope === 'school' && data.school_ids.length === 0) {
    data.scope = 'district';
  }
  if (data.scope === 'department' && data.department_ids.length === 0) {
    data.scope = 'district';
  }
  if (data.scope === 'district') {
    data.school_ids = [];
    data.department_ids = [];
  }

  return {
    ok: true,
    result: {
      data,
      cost_usd: estimateCostUsd(MODEL_SONNET, resp.usage),
      raw_text: resp.text,
    },
  };
}
