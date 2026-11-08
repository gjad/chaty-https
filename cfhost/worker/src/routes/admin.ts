import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import type { AppEnv } from '../lib/auth';
import { getHub, rateBlocked, rateFail } from '../lib/access';
import { UPLOAD_KEY_PATTERN, clientKey, readJsonBody } from '../lib/util';
import { sniffImage } from './upload';
import { recordAudit } from '../lib/audit';
import { securityLog } from '../lib/log';

// Operational endpoints, disabled unless the ADMIN_TOKEN secret is set.
//   POST /api/admin/agents        {username, password, name?}        create an agent account
//   POST /api/admin/import        {table, rows: [...]}               bulk insert (migration from the self-hosted DB)
//   PUT  /api/admin/files/<key>   raw body, Content-Type: image/*    write an upload straight into R2
//   GET  /api/admin/stats                                            row counts per table
const admin = new Hono<AppEnv>();

const MAX_IMPORT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_FIELD_CHARS = 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_AGENT_USERNAME = 64;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const encoder = new TextEncoder();

const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

admin.use('*', async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) return c.json({ error: 'Not found' }, 404);

  const ip = clientKey(c.req.raw);
  const blocked = await rateBlocked(c.env, 'admin-fail', ip, 10, FAIL_WINDOW_MS);
  if (blocked !== null) {
    securityLog('admin_rate_limited', c.req.raw);
    c.header('Retry-After', String(blocked));
    return c.json({ error: 'Too many failed attempts' }, 429);
  }

  const provided = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!provided || !(await tokensMatch(provided, expected))) {
    securityLog('admin_unauthorized', c.req.raw);
    await rateFail(c.env, 'admin-fail', ip, 10, FAIL_WINDOW_MS);
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

admin.post('/agents', async (c) => {
  const parsed = await readJsonBody(c.req.raw, 8 * 1024);
  if (!parsed.ok) return c.json({ error: 'Invalid request' }, parsed.status);
  const body = parsed.body;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : username;

  if (!username || username.length > MAX_AGENT_USERNAME || password.length < 8) {
    return c.json({ error: `username (max ${MAX_AGENT_USERNAME} chars) and a password of at least 8 characters are required` }, 400);
  }

  const result = await getHub(c.env).adminCreateAgent({ username, passwordHash: await bcrypt.hash(password, 10), name });
  if ('error' in result) return c.json({ error: 'Username already exists' }, 409);
  recordAudit(c, { actorType: 'admin', actorId: 'admin-token', action: 'admin_create_agent', result: 'ok', target: username, detail: `agentId=${result.agentId}` });
  return c.json({ success: true, agentId: result.agentId });
});

admin.post('/import', async (c) => {
  const parsed = await readJsonBody(c.req.raw, MAX_IMPORT_BODY_BYTES);
  if (!parsed.ok) return c.json({ error: parsed.status === 413 ? 'Payload too large' : 'Invalid request' }, parsed.status);
  const body = parsed.body as { table?: unknown; rows?: unknown };
  const table = typeof body.table === 'string' ? body.table : '';
  if (!table || !Array.isArray(body.rows)) return c.json({ error: 'table and rows are required' }, 400);
  if (body.rows.length > 1000) return c.json({ error: 'At most 1000 rows per request' }, 400);

  for (const row of body.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return c.json({ error: 'Every row must be an object' }, 400);
    for (const value of Object.values(row as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > MAX_IMPORT_FIELD_CHARS) return c.json({ error: 'Field too large' }, 400);
    }
  }

  try {
    const imported = await getHub(c.env).adminImport(table, body.rows as Record<string, unknown>[]);
    recordAudit(c, { actorType: 'admin', actorId: 'admin-token', action: 'admin_import', result: 'ok', target: table, detail: `rows=${imported}` });
    return c.json({ success: true, imported });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Import failed' }, 400);
  }
});

admin.put('/files/*', async (c) => {
  const prefix = '/api/admin/files/';
  let key = '';
  try {
    key = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length));
  } catch {
    return c.json({ error: 'Invalid key' }, 400);
  }
  if (!key || key.includes('..') || !UPLOAD_KEY_PATTERN.test(key)) return c.json({ error: 'Invalid key' }, 400);

  const declared = Number(c.req.header('content-length'));
  if (!Number.isFinite(declared) || declared <= 0) return c.json({ error: 'Content-Length required' }, 411);
  if (declared > MAX_FILE_BYTES) return c.json({ error: 'File too large' }, 413);

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) return c.json({ error: 'File too large' }, 413);
  const detected = sniffImage(bytes);
  if (!detected) return c.json({ error: 'Only jpeg, png, gif and webp images are accepted' }, 400);

  await c.env.UPLOADS.put(key, bytes, { httpMetadata: { contentType: detected.mime } });
  recordAudit(c, { actorType: 'admin', actorId: 'admin-token', action: 'admin_put_file', result: 'ok', target: key, detail: `bytes=${bytes.byteLength}` });
  return c.json({ success: true, key });
});

admin.get('/stats', async (c) => c.json(await getHub(c.env).adminCounts()));

export default admin;
