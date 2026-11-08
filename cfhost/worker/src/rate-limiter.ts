import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

interface WindowState {
  count: number;
  resetAt: number;
}

// Fixed-window counter, one instance per "<bucket>:<ip>". Replaces express-rate-limit
// (Workers' built-in rate limit binding only supports 10s / 60s windows).
export class RateLimiter extends DurableObject<Env> {
  async hit(limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const now = Date.now();
    let state = await this.ctx.storage.get<WindowState>('w');
    if (!state || state.resetAt <= now) {
      state = { count: 0, resetAt: now + windowMs };
      await this.ctx.storage.setAlarm(state.resetAt + 1000);
    }
    state.count += 1;
    await this.ctx.storage.put('w', state);
    return {
      allowed: state.count <= limit,
      retryAfterSec: Math.max(1, Math.ceil((state.resetAt - now) / 1000))
    };
  }

  // Read-only: has the window already seen `limit` hits?
  async check(limit: number, windowMs: number): Promise<{ blocked: boolean; retryAfterSec: number }> {
    const now = Date.now();
    const state = await this.ctx.storage.get<WindowState>('w');
    if (!state || state.resetAt <= now) return { blocked: false, retryAfterSec: 0 };
    void windowMs;
    return { blocked: state.count >= limit, retryAfterSec: Math.max(1, Math.ceil((state.resetAt - now) / 1000)) };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
