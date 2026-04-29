import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Bindings } from '../index';
import { ulid } from '../lib/ulid';

export const SESSION_COOKIE = 'def_session';

export interface SessionUser {
  id: string;
  email: string;
  display_name: string | null;
  is_employee: boolean;
  is_district_admin: boolean;
}

export interface AppVariables {
  user: SessionUser;
  sessionId: string;
}

export type AppContext = Context<{ Bindings: Bindings; Variables: AppVariables }>;

function isEmployeeEmail(email: string, env: Bindings): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const employeeDomains = (env.EMPLOYEE_EMAIL_DOMAIN ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return employeeDomains.includes(domain);
}

export async function findOrCreateUserByEmail(
  env: Bindings,
  email: string,
): Promise<SessionUser> {
  const lower = email.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  const existing = await env.DB.prepare(
    `SELECT id, email, display_name, is_employee, is_district_admin
     FROM users WHERE email = ?`,
  )
    .bind(lower)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      is_employee: number;
      is_district_admin: number;
    }>();

  if (existing) {
    await env.DB.prepare(`UPDATE users SET last_login = ?, last_active = ? WHERE id = ?`)
      .bind(now, now, existing.id)
      .run();
    return {
      id: existing.id,
      email: existing.email,
      display_name: existing.display_name,
      is_employee: existing.is_employee === 1,
      is_district_admin: existing.is_district_admin === 1,
    };
  }

  const id = ulid();
  const isEmployee = isEmployeeEmail(lower, env) ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO users (id, email, auth_provider, is_employee, is_district_admin, created_at, last_login, last_active)
     VALUES (?, ?, 'magic_link', ?, 0, ?, ?, ?)`,
  )
    .bind(id, lower, isEmployee, now, now, now)
    .run();

  return {
    id,
    email: lower,
    display_name: null,
    is_employee: isEmployee === 1,
    is_district_admin: false,
  };
}

export async function createSession(
  env: Bindings,
  userId: string,
  ip?: string,
  userAgent?: string,
): Promise<{ id: string; expiresAt: number }> {
  const ttlDays = parseInt(env.SESSION_TTL_DAYS ?? '30', 10);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlDays * 86400;
  const id = ulid();

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, now, expiresAt, userAgent ?? null, ip ?? null)
    .run();

  return { id, expiresAt };
}

export function setSessionCookie(c: AppContext, sessionId: string, expiresAt: number): void {
  const isLocal = c.env.ENVIRONMENT !== 'production';
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt * 1000),
  });
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function deleteSession(env: Bindings, sessionId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}

export async function loadSession(
  env: Bindings,
  sessionId: string,
): Promise<SessionUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.is_employee, u.is_district_admin
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > unixepoch()`,
  )
    .bind(sessionId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      is_employee: number;
      is_district_admin: number;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_employee: row.is_employee === 1,
    is_district_admin: row.is_district_admin === 1,
  };
}

export function requireSession(): MiddlewareHandler<{
  Bindings: Bindings;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (!sid) return c.json({ error: 'unauthorized' }, 401);
    const user = await loadSession(c.env, sid);
    if (!user) {
      clearSessionCookie(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('user', user);
    c.set('sessionId', sid);
    await next();
  };
}

export function requireDistrictAdmin(): MiddlewareHandler<{
  Bindings: Bindings;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (!sid) return c.json({ error: 'unauthorized' }, 401);
    const user = await loadSession(c.env, sid);
    if (!user) {
      clearSessionCookie(c);
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (!user.is_district_admin) return c.json({ error: 'forbidden' }, 403);
    c.set('user', user);
    c.set('sessionId', sid);
    await next();
  };
}
