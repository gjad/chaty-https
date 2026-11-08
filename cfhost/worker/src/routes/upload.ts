import { Hono } from 'hono';
import { resolveAgent, verifiedVisitorIds } from '../lib/auth';
import type { AppEnv } from '../lib/auth';
import { getHub, rateLimit } from '../lib/access';
import { ROOM_ID_PATTERN, clientKey } from '../lib/util';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024; // multipart overhead
const ALLOWED_EXT = /\.(jpe?g|png|gif|webp)$/i;
const ALLOWED_MIME = /^image\/(jpeg|jpg|png|gif|webp)$/i;
const NOT_AN_IMAGE = '仅允许上传图片文件 (jpeg, jpg, png, gif, webp)';

type Detected = { ext: string; mime: string };

// Trust file contents, not the client-supplied name / content type.
export function sniffImage(bytes: Uint8Array): Detected | null {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' };
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' };
  if (startsWith(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

const upload = new Hono<AppEnv>();

upload.post('/', async (c) => {
  // 1) identity first (so anonymous traffic cannot burn the quota of real users): live agent session, otherwise
  //    visitor cookie / token
  let identity: { type: 'agent' | 'visitor'; id: string } | null = null;
  const resolved = await resolveAgent(c);
  if (resolved) {
    identity = { type: 'agent', id: resolved.agent.agentId };
  } else {
    const [visitorId] = await verifiedVisitorIds(c);
    if (visitorId) identity = { type: 'visitor', id: visitorId };
  }
  if (!identity) return c.json({ error: 'Unauthorized upload request' }, 401);

  // Per identity (visitors 20 / agents 60 per 15 minutes) and per address (shared offices stay usable).
  const perIdentity = await rateLimit(c.env, 'upload', `${identity.type}:${identity.id}`, identity.type === 'agent' ? 60 : 20, 15 * 60 * 1000);
  const perAddress = perIdentity === null ? await rateLimit(c.env, 'upload-ip', clientKey(c.req.raw), 100, 15 * 60 * 1000) : perIdentity;
  if (perAddress !== null) {
    c.header('Retry-After', String(perAddress));
    return c.json({ error: '上传次数过多，请稍后再试' }, 429);
  }
  // 2) size guard before buffering the body
  const length = Number(c.req.header('content-length'));
  if (!Number.isFinite(length) || length <= 0) return c.json({ error: 'Content-Length required' }, 411);
  if (length > MAX_BODY_BYTES) return c.json({ error: 'File too large' }, 413);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'Invalid form data' }, 400);
  }

  const file = form.get('image');
  if (!(file instanceof File)) return c.json({ error: 'No file uploaded' }, 400);
  if (file.size > MAX_FILE_BYTES) return c.json({ error: 'File too large' }, 413);
  if (!ALLOWED_EXT.test(file.name) || !ALLOWED_MIME.test(file.type)) return c.json({ error: NOT_AN_IMAGE }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = sniffImage(bytes);
  if (!detected) return c.json({ error: NOT_AN_IMAGE }, 400);

  // 3) room authorization (before anything is written)
  const rawRoomId = form.get('roomId');
  const requestRoomId = typeof rawRoomId === 'string' ? rawRoomId.trim() : '';
  if (requestRoomId && !ROOM_ID_PATTERN.test(requestRoomId)) return c.json({ error: 'Invalid roomId' }, 400);

  const hub = getHub(c.env);
  const auth = await hub.authorizeUpload({ roomId: requestRoomId, identity });
  if (!auth.ok) {
    return c.json(auth.code ? { error: auth.error, code: auth.code } : { error: auth.error }, auth.status);
  }

  // 4) store: R2 first, then the metadata row; roll the object back if the row cannot be written
  const now = new Date();
  const subdir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const key = `${subdir}/${now.getTime()}-${crypto.randomUUID()}.${detected.ext}`;

  await c.env.UPLOADS.put(key, bytes, { httpMetadata: { contentType: detected.mime } });

  try {
    await hub.recordUpload({ filename: key, roomId: auth.roomId, uploaderType: identity.type, uploaderId: identity.id });
  } catch (err) {
    await c.env.UPLOADS.delete(key).catch(() => undefined);
    console.error('Failed to persist upload metadata:', err);
    return c.json({ error: 'Failed to save upload metadata' }, 500);
  }

  return c.json({ url: `/chatuploads/${key}`, roomId: auth.roomId });
});

export default upload;
