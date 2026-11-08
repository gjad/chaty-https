import { Hono } from 'hono';
import { authenticateAgent, resolveAgent, verifiedVisitorIds } from '../lib/auth';
import type { AppEnv } from '../lib/auth';
import { getHub } from '../lib/access';
import { recordAudit } from '../lib/audit';
import { ROOM_ID_PATTERN, readJsonBody } from '../lib/util';

const MAX_KB_BODY_BYTES = 1024 * 1024;
const MAX_KB_ITEMS = 2000;

const api = new Hono<AppEnv>();

// Chat history: any agent with a live session, or the visitor that owns the room (decided inside the hub).
api.get('/history/:roomId', async (c) => {
  try {
    const roomId = c.req.param('roomId');
    if (!ROOM_ID_PATTERN.test(roomId)) return c.json({ error: 'Invalid room format' }, 403);

    const parsedLimit = Number.parseInt(c.req.query('limit') ?? '20', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20;

    const result = await getHub(c.env).getHistory({
      roomId,
      limit,
      before: c.req.query('before') || undefined,
      agent: !!(await resolveAgent(c)),
      visitorIds: await verifiedVisitorIds(c)
    });

    if (!result.ok) return c.json({ error: 'Unauthorized' }, 401);
    const { ok: _ok, ...payload } = result;
    return c.json(payload);
  } catch (err) {
    console.error('Failed to fetch history:', err);
    return c.json({ error: 'Failed to fetch history' }, 500);
  }
});

// Shared knowledge base (editable by any authenticated agent). `version` supports optimistic locking: a PUT that
// carries a stale `baseVersion` is rejected with 409 instead of silently overwriting another agent's edit.
api.get('/knowledge-base', authenticateAgent, async (c) => {
  try {
    const hub = getHub(c.env);
    return c.json({ categories: await hub.getKnowledge(), version: await hub.getKnowledgeVersion() });
  } catch (err) {
    console.error('Failed to fetch knowledge base:', err);
    return c.json({ error: 'Failed to fetch knowledge base' }, 500);
  }
});

api.put('/knowledge-base', authenticateAgent, async (c) => {
  const parsed = await readJsonBody(c.req.raw, MAX_KB_BODY_BYTES);
  if (!parsed.ok) return c.json({ error: parsed.status === 413 ? 'Payload too large' : 'Invalid categories payload' }, parsed.status);

  const categories = parsed.body.categories;
  if (!Array.isArray(categories)) return c.json({ error: 'Invalid categories payload' }, 400);
  if (categories.length > 100) return c.json({ error: 'Too many categories' }, 400);
  const baseVersion = typeof parsed.body.baseVersion === 'number' ? parsed.body.baseVersion : undefined;

  const rows: { category: string; categoryOrder: number; title: string; content: string; sortOrder: number }[] = [];
  for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
    const category = categories[categoryIndex] as { name?: unknown; items?: unknown } | null;
    const name = String(category?.name || '').trim();
    if (!name) continue;

    const items = Array.isArray(category?.items) ? (category!.items as unknown[]) : [];
    if (items.length > 500) return c.json({ error: 'Too many items in category' }, 400);

    items.forEach((raw, itemIndex) => {
      const item = raw as { title?: unknown; content?: unknown } | null;
      const title = String(item?.title || '').trim();
      const content = String(item?.content || '').trim();
      if (!title || !content) return;
      rows.push({
        category: name.slice(0, 80),
        categoryOrder: categoryIndex,
        title: title.slice(0, 120),
        content: content.slice(0, 2000),
        sortOrder: itemIndex
      });
    });
  }
  if (rows.length > MAX_KB_ITEMS) return c.json({ error: 'Too many items' }, 400);

  try {
    const result = await getHub(c.env).replaceKnowledge(rows, baseVersion);
    if (!result.ok) return c.json({ error: '知识库已被其他客服修改，请刷新后重试', code: 'CONFLICT' }, 409);
    recordAudit(c, {
      actorType: 'agent',
      actorId: c.get('agent').agentId,
      action: 'kb_update',
      result: 'ok',
      detail: `items=${result.total} version=${result.version}`
    });
    return c.json({ success: true, total: result.total, version: result.version });
  } catch (err) {
    console.error('Failed to update knowledge base:', err);
    return c.json({ error: 'Failed to update knowledge base' }, 500);
  }
});

// Operation log (logins, password changes, knowledge-base edits): any signed-in agent may read the newest
// AUDIT_PAGE_SIZE * AUDIT_MAX_PAGES entries. Older history is only reachable through the Durable Object database.
const AUDIT_PAGE_SIZE = 100;
const AUDIT_MAX_PAGES = 5;

api.get('/audit-log', authenticateAgent, async (c) => {
  const parsed = Number.parseInt(c.req.query('page') ?? '1', 10);
  const page = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), AUDIT_MAX_PAGES) : 1;
  try {
    // One extra row tells whether another page exists.
    const rows = await getHub(c.env).listAudit(AUDIT_PAGE_SIZE + 1, (page - 1) * AUDIT_PAGE_SIZE);
    return c.json({
      page,
      maxPages: AUDIT_MAX_PAGES,
      hasMore: page < AUDIT_MAX_PAGES && rows.length > AUDIT_PAGE_SIZE,
      rows: rows.slice(0, AUDIT_PAGE_SIZE).map(({ ua: _ua, ...row }) => row)
    });
  } catch (err) {
    console.error('Failed to fetch audit log:', err);
    return c.json({ error: 'Failed to fetch audit log' }, 500);
  }
});

export default api;
