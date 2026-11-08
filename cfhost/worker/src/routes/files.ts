import { Hono } from 'hono';
import { resolveAgent, verifiedVisitorIds } from '../lib/auth';
import type { AppEnv } from '../lib/auth';
import { getHub } from '../lib/access';
import { UPLOAD_KEY_PATTERN } from '../lib/util';

const files = new Hono<AppEnv>();

// Access-controlled image delivery: the room's visitor or any agent.
files.get('/*', async (c) => {
  const prefix = '/chatuploads/';
  let key = '';
  try {
    key = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length)).trim();
  } catch {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  if (!key || key.includes('..') || key.includes('\\') || key.startsWith('/') || !UPLOAD_KEY_PATTERN.test(key)) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const access = await getHub(c.env).getFileAccess({
    key,
    agent: !!(await resolveAgent(c)),
    visitorIds: await verifiedVisitorIds(c)
  });
  if (access === 'not-found') return c.json({ error: 'File not found' }, 404);
  if (access === 'forbidden') return c.json({ error: 'Forbidden' }, 403);

  const object = await c.env.UPLOADS.get(key);
  if (!object) return c.json({ error: 'File not found' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'private, max-age=600');
  headers.set('X-Content-Type-Options', 'nosniff');
  // The visitor token may travel in ?vt= - never leak it through the Referer header.
  headers.set('Referrer-Policy', 'no-referrer');

  if (c.req.header('if-none-match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
});

export default files;
