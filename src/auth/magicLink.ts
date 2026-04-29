import type { Bindings } from '../index';

// 32 random bytes → 43-char URL-safe base64. The plaintext goes in the email
// link; only the SHA-256 hash is persisted in the magic_links table.
export function generateMagicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface IssuedMagicLink {
  url: string;
  expiresAt: number;
}

export async function issueMagicLink(
  env: Bindings,
  email: string,
  ip?: string,
): Promise<IssuedMagicLink> {
  const ttlMinutes = parseInt(env.MAGIC_LINK_TTL_MINUTES ?? '15', 10);
  const ttlSeconds = ttlMinutes * 60;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;

  const token = generateMagicToken();
  const hashed = await hashToken(token);

  await env.DB.prepare(
    `INSERT INTO magic_links (token, email, created_at, expires_at, ip_address)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(hashed, email.toLowerCase(), now, expiresAt, ip ?? null)
    .run();

  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const url = `${base}/submit/verify?token=${encodeURIComponent(token)}`;
  return { url, expiresAt };
}

export interface ConsumedMagicLink {
  email: string;
}

export async function consumeMagicLink(
  env: Bindings,
  token: string,
): Promise<ConsumedMagicLink | null> {
  const hashed = await hashToken(token);
  const now = Math.floor(Date.now() / 1000);

  const row = await env.DB.prepare(
    `SELECT email, expires_at, used_at FROM magic_links WHERE token = ?`,
  )
    .bind(hashed)
    .first<{ email: string; expires_at: number; used_at: number | null }>();

  if (!row) return null;
  if (row.used_at !== null) return null;
  if (row.expires_at <= now) return null;

  // Mark used. Race-safe: only succeeds if still unused.
  const upd = await env.DB.prepare(
    `UPDATE magic_links SET used_at = ? WHERE token = ? AND used_at IS NULL`,
  )
    .bind(now, hashed)
    .run();

  if (!upd.meta.changes || upd.meta.changes === 0) return null;

  return { email: row.email.toLowerCase() };
}
