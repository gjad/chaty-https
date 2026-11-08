import type { Env } from '../types';

// All persistent data lives inside the ChatHub object, so every data access goes through this stub.
export const getHub = (env: Env) => {
  const id = env.HUB.idFromName('main');
  const hint = env.HUB_LOCATION_HINT as DurableObjectLocationHint | undefined;
  return hint ? env.HUB.get(id, { locationHint: hint }) : env.HUB.get(id);
};

// Rate limiting must never take the product down: if the RateLimiter object itself fails, the request is let through.

// Counts one hit. Returns null when allowed, otherwise the Retry-After seconds.
export async function rateLimit(
  env: Env,
  bucket: string,
  key: string,
  limit: number,
  windowMs: number
): Promise<number | null> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${bucket}:${key}`));
    const result = await stub.hit(limit, windowMs);
    return result.allowed ? null : result.retryAfterSec;
  } catch (err) {
    console.error('rateLimit failed (allowing request):', err instanceof Error ? err.message : err);
    return null;
  }
}

// Read-only check: returns the Retry-After seconds when `limit` hits were already recorded in the window.
export async function rateBlocked(
  env: Env,
  bucket: string,
  key: string,
  limit: number,
  windowMs: number
): Promise<number | null> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`${bucket}:${key}`));
    const result = await stub.check(limit, windowMs);
    return result.blocked ? result.retryAfterSec : null;
  } catch (err) {
    console.error('rateBlocked failed (allowing request):', err instanceof Error ? err.message : err);
    return null;
  }
}

// Records one failure (used together with rateBlocked so that only failed attempts count).
export async function rateFail(env: Env, bucket: string, key: string, limit: number, windowMs: number): Promise<void> {
  await rateLimit(env, bucket, key, limit, windowMs);
}
