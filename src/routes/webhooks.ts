// Inbound provider webhooks. Phase 1 only carries Resend (deliverability
// hygiene — bounce / complaint → suppression). Future phases will add
// Stripe and Twilio handlers in this same file.
//
//   POST /webhooks/resend     Svix-signed events from the Resend dashboard
//
// Resend uses Svix for signing. We verify three headers:
//   svix-id, svix-timestamp, svix-signature
// and compute HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the
// secret value (after stripping its `whsec_` prefix and base64-decoding).
// Then compare against any of the space-separated v1,base64 signatures
// in the header.

import { Hono } from 'hono';
import type { Bindings } from '../index';

const api = new Hono<{ Bindings: Bindings }>();

// Reject events whose timestamp drifts more than this window — replay
// protection per the Svix spec.
const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

async function importSecretKey(secret: string): Promise<CryptoKey> {
  // Resend / Svix secrets are formatted as `whsec_<base64>`. Strip the
  // prefix and base64-decode the remaining bytes — those bytes are the
  // raw HMAC key.
  const trimmed = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBytes = base64Decode(trimmed);
  return await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function verifySvixSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignatureHeader: string,
  secret: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!svixId || !svixTimestamp || !svixSignatureHeader) {
    return { ok: false, reason: 'missing_headers' };
  }
  const ts = parseInt(svixTimestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid_timestamp' };
  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (drift > SVIX_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_skew' };
  }

  const key = await importSecretKey(secret);
  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
  const expected = base64Encode(new Uint8Array(sig));

  // Header format: "v1,sig1 v1,sig2 ..."
  const parts = svixSignatureHeader.split(' ');
  for (const p of parts) {
    const [version, encoded] = p.split(',');
    if (version === 'v1' && encoded === expected) return { ok: true };
  }
  return { ok: false, reason: 'signature_mismatch' };
}

interface ResendEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
    complaint?: { feedbackType?: string };
  };
}

async function handleBounce(env: Bindings, event: ResendEvent): Promise<void> {
  const messageId = event.data?.email_id;
  const recipients = normalizeRecipients(event.data?.to);
  const bounceType = event.data?.bounce?.type ?? '';
  // Only hard bounces should suppress. Soft / transient bounces will retry.
  const isHard = /permanent|hard/i.test(bounceType);
  const reason = isHard ? 'bounce' : 'soft_bounce';
  const now = Math.floor(Date.now() / 1000);

  if (messageId) {
    await env.DB.prepare(
      `UPDATE deliveries SET status = ?, error = ? WHERE provider_message_id = ?`,
    )
      .bind(isHard ? 'bounced' : 'soft_bounced', JSON.stringify(event.data?.bounce ?? {}), messageId)
      .run();
  }
  if (isHard) {
    for (const addr of recipients) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO suppressions (channel, identifier, reason, recorded_at) VALUES ('email', ?, ?, ?)`,
      )
        .bind(addr.toLowerCase(), reason, now)
        .run();
    }
  }
}

async function handleComplaint(env: Bindings, event: ResendEvent): Promise<void> {
  const messageId = event.data?.email_id;
  const recipients = normalizeRecipients(event.data?.to);
  const now = Math.floor(Date.now() / 1000);

  if (messageId) {
    await env.DB.prepare(
      `UPDATE deliveries SET status = 'complaint', error = ? WHERE provider_message_id = ?`,
    )
      .bind(JSON.stringify(event.data?.complaint ?? {}), messageId)
      .run();
  }
  for (const addr of recipients) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO suppressions (channel, identifier, reason, recorded_at) VALUES ('email', ?, 'complaint', ?)`,
    )
      .bind(addr.toLowerCase(), now)
      .run();
  }
}

async function handleOpened(env: Bindings, event: ResendEvent): Promise<void> {
  const messageId = event.data?.email_id;
  if (!messageId) return;
  const now = Math.floor(Date.now() / 1000);
  // Don't overwrite an existing opened_at — first open wins.
  await env.DB.prepare(
    `UPDATE deliveries SET opened_at = COALESCE(opened_at, ?) WHERE provider_message_id = ?`,
  )
    .bind(now, messageId)
    .run();
}

async function handleClicked(env: Bindings, event: ResendEvent): Promise<void> {
  const messageId = event.data?.email_id;
  if (!messageId) return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE deliveries SET clicked_at = COALESCE(clicked_at, ?) WHERE provider_message_id = ?`,
  )
    .bind(now, messageId)
    .run();
}

async function handleDelivered(env: Bindings, event: ResendEvent): Promise<void> {
  const messageId = event.data?.email_id;
  if (!messageId) return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE deliveries SET status = CASE WHEN status IN ('sent','queued') THEN 'delivered' ELSE status END,
            delivered_at = COALESCE(delivered_at, ?)
     WHERE provider_message_id = ?`,
  )
    .bind(now, messageId)
    .run();
}

function normalizeRecipients(to: string[] | string | undefined): string[] {
  if (!to) return [];
  if (Array.isArray(to)) return to.filter((s) => typeof s === 'string');
  return [to];
}

// ─── POST /webhooks/resend ─────────────────────────────────────────────────
api.post('/resend', async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhooks/resend] RESEND_WEBHOOK_SECRET is not configured');
    return c.json({ error: 'webhook_disabled' }, 503);
  }

  const rawBody = await c.req.text();
  const svixId = c.req.header('svix-id') ?? '';
  const svixTs = c.req.header('svix-timestamp') ?? '';
  const svixSig = c.req.header('svix-signature') ?? '';

  const verify = await verifySvixSignature(rawBody, svixId, svixTs, svixSig, secret);
  if (!verify.ok) {
    console.warn('[webhooks/resend] signature verify failed', verify.reason);
    return c.json({ error: 'invalid_signature', reason: verify.reason }, 401);
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    switch (event.type) {
      case 'email.bounced':
        await handleBounce(c.env, event);
        break;
      case 'email.complained':
        await handleComplaint(c.env, event);
        break;
      case 'email.delivered':
        await handleDelivered(c.env, event);
        break;
      case 'email.opened':
        await handleOpened(c.env, event);
        break;
      case 'email.clicked':
        await handleClicked(c.env, event);
        break;
      // email.sent, email.delivery_delayed, email.failed — currently no-op,
      // but we still 200 so Resend doesn't retry.
      default:
        break;
    }
  } catch (err) {
    console.error('[webhooks/resend] handler error', event.type, err);
    // Returning 500 makes Resend retry — appropriate for transient errors.
    return c.json({ error: 'handler_error' }, 500);
  }

  return c.json({ ok: true });
});

export default api;
