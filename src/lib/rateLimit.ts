import type { Bindings } from '../index';

// Sliding-window-ish rate limiter. Stores {count, expiresAt} so increments don't
// reset the original window — KV's expirationTtl always overrides, so we track the
// expiry inside the value and re-write the remaining TTL each time.
export async function rateLimit(
  env: Bindings,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const data = await env.KV.get<{ count: number; expiresAt: number }>(key, 'json');

  if (data && data.expiresAt > now) {
    if (data.count >= limit) {
      return { allowed: false, remaining: 0, retryAfter: data.expiresAt - now };
    }
    const newCount = data.count + 1;
    await env.KV.put(
      key,
      JSON.stringify({ count: newCount, expiresAt: data.expiresAt }),
      { expirationTtl: Math.max(60, data.expiresAt - now) },
    );
    return { allowed: true, remaining: limit - newCount, retryAfter: 0 };
  }

  await env.KV.put(
    key,
    JSON.stringify({ count: 1, expiresAt: now + windowSeconds }),
    { expirationTtl: windowSeconds },
  );
  return { allowed: true, remaining: limit - 1, retryAfter: 0 };
}
