import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './auth';
import type { Env } from '../types';
import { securityLog } from './log';

// Website authorization for the embed widget.
//
// ALLOWED_ORIGINS is a comma separated list of sites that may use the chat widget:
//   https://www.example.com      exact origin (scheme + host [+ port])
//   https://*.example.com        any subdomain (does NOT include example.com itself - list it too)
//   example.com / *.example.com  host only, any scheme
// Empty / unset = nobody is allowed (fail closed). Local development can set ALLOW_ANY_ORIGIN=true instead.
// The Worker's own origin (the agent app) is always allowed.
//
// Browsers set the Origin header themselves and pages cannot forge it, so this stops the widget from
// working on sites that merely copied the script. It is not a defence against a script that fakes the
// header outside a browser; pair it with Cloudflare bot protection / rate limits for that.

const parseList = (raw: string | undefined): string[] =>
  (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const hostMatches = (host: string, pattern: string): boolean =>
  pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern;

export function isOriginAllowed(origin: string | null | undefined, env: Env, selfOrigin: string): boolean {
  if (env.ALLOW_ANY_ORIGIN === 'true') return true;
  if (!origin) return false;
  if (origin === selfOrigin) return true;

  const list = parseList(env.ALLOWED_ORIGINS);
  if (!list.length) return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.host.toLowerCase();

  return list.some((entry) => {
    const idx = entry.indexOf('://');
    if (idx < 0) return hostMatches(host, entry);
    return url.protocol === entry.slice(0, idx + 1) && hostMatches(host, entry.slice(idx + 3));
  });
}

export const selfOriginOf = (req: Request): string => new URL(req.url).origin;

export const originGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isOriginAllowed(c.req.header('origin'), c.env, selfOriginOf(c.req.raw))) {
    securityLog('origin_rejected', c.req.raw, { origin: (c.req.header('origin') || '').slice(0, 200) });
    return c.json({ error: 'Origin not allowed' }, 403);
  }
  await next();
};

// CSRF guard for agent-only state-changing endpoints (login, logout, change-password, knowledge base, translate):
// the agent app is same-origin, so a request carrying a *different* Origin is never legitimate - not even from
// another site that is allowed to embed the widget or from a sibling subdomain. Requests without an Origin
// header (curl, scripts) are not browser CSRF and fall through to their own authentication.
export const sameOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.ALLOW_ANY_ORIGIN !== 'true') {
    const method = c.req.method;
    const origin = c.req.header('origin');
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && origin && origin !== selfOriginOf(c.req.raw)) {
      securityLog('csrf_origin_rejected', c.req.raw, { origin: origin.slice(0, 200) });
      return c.json({ error: 'Origin not allowed' }, 403);
    }
  }
  await next();
};
