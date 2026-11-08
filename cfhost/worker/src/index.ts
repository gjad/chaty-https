import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './lib/auth';
import { getHub, rateLimit } from './lib/access';
import { isOriginAllowed, originGuard, sameOriginGuard, selfOriginOf } from './lib/origin';
import { clientKey } from './lib/util';
import { securityLog } from './lib/log';
import auth from './routes/auth';
import content from './routes/content';
import translate from './routes/translate';
import upload from './routes/upload';
import files from './routes/files';
import admin from './routes/admin';

export { ChatHub } from './hub';
export { RateLimiter } from './rate-limiter';

const app = new Hono<AppEnv>();

// Refuse to run with a missing / trivially short signing secret instead of silently signing with it.
app.use('*', async (c, next) => {
  const secret = c.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    console.error('JWT_SECRET is missing or shorter than 16 characters');
    return c.json({ error: 'Server misconfigured' }, 500);
  }
  await next();
});

// The embed widget runs on third-party sites: only origins listed in ALLOWED_ORIGINS (plus our own) get CORS
// headers, and the visitor entry points below reject other origins outright.
// Not applied to /ws: a 101 upgrade response has immutable headers.
const corsMiddleware = cors({
  origin: (origin, c) => (isOriginAllowed(origin, c.env, selfOriginOf(c.req.raw)) ? origin : null),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-session-id', 'x-visitor-token'],
  maxAge: 86400
});
app.use('/api/*', corsMiddleware);
app.use('/chatuploads/*', corsMiddleware);
app.use('/api/visitor-auth', originGuard);
app.use('/api/upload', originGuard);

// Agent-only mutations are same-origin only (CSRF defence on top of SameSite=Lax cookies).
for (const path of ['/api/login', '/api/logout', '/api/change-password', '/api/knowledge-base', '/api/translate', '/api/translate/*']) {
  app.use(path, sameOriginGuard);
}

app.get('/api/health', (c) => c.json({ ok: true, version: c.env.APP_VERSION }));

app.route('/api', auth);
app.route('/api', content);
app.route('/api/translate', translate);
app.route('/api/upload', upload);
app.route('/api/admin', admin);
app.route('/chatuploads', files);

app.get('/ws', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }
  if (!isOriginAllowed(c.req.header('origin'), c.env, selfOriginOf(c.req.raw))) {
    securityLog('ws_origin_rejected', c.req.raw, { origin: (c.req.header('origin') || '').slice(0, 200) });
    return c.text('Origin not allowed', 403);
  }
  // Connection storms: 120 upgrades per minute per client address (/64 for IPv6).
  const retry = await rateLimit(c.env, 'ws', clientKey(c.req.raw), 120, 60_000);
  if (retry !== null) {
    securityLog('ws_rate_limited', c.req.raw);
    c.header('Retry-After', String(retry));
    return c.text('Too many connections', 429);
  }
  return getHub(c.env).fetch(c.req.raw);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
