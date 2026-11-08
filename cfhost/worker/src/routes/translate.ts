import { Hono } from 'hono';
import { authenticateAgent } from '../lib/auth';
import type { AppEnv } from '../lib/auth';
import { rateLimit } from '../lib/access';
import { readJsonBody } from '../lib/util';

const GOOGLE_TRANSLATE_API_URL = 'https://translation.googleapis.com/language/translate/v2';

const translate = new Hono<AppEnv>();

translate.post('/', authenticateAgent, async (c) => {
  // The composer translates while typing (debounced), so the quota is generous but still bounded per agent.
  const retry = await rateLimit(c.env, 'translate', c.get('agent').agentId, 600, 10 * 60 * 1000);
  if (retry !== null) {
    c.header('Retry-After', String(retry));
    return c.json({ error: 'Too many translation requests' }, 429);
  }

  const parsed = await readJsonBody(c.req.raw, 64 * 1024);
  if (!parsed.ok && parsed.status === 413) return c.json({ error: 'Text too long' }, 413);
  const body: Record<string, unknown> = parsed.ok ? parsed.body : {};
  const q = String(body?.q || '').trim();
  const source = String(body?.source || 'auto').trim() || 'auto';
  const target = String(body?.target || 'zh').trim() || 'zh';
  const format = body?.format === 'html' ? 'html' : 'text';
  const apiKey = String(c.env.GOOGLE_TRANSLATE_API_KEY || '').trim();

  if (!q) return c.json({ error: 'Missing text to translate' }, 400);
  if (q.length > 10000) return c.json({ error: 'Text too long' }, 400);
  if (!apiKey) return c.json({ error: 'Translation service is not configured' }, 503);

  const payload: Record<string, string> = { q, target, format };
  if (source !== 'auto') payload.source = source;

  try {
    const res = await fetch(`${GOOGLE_TRANSLATE_API_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      console.error('Translation upstream error:', res.status, (await res.text().catch(() => '')).slice(0, 500));
      return c.json({ error: 'Failed to translate' }, 502);
    }

    const data = (await res.json()) as {
      data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
    };
    const translation = data?.data?.translations?.[0];
    const translatedText = String(translation?.translatedText || '').trim();
    if (!translatedText) return c.json({ error: 'Empty translation response' }, 502);

    return c.json({ translatedText, detectedLanguage: translation?.detectedSourceLanguage || source || null });
  } catch (err) {
    console.error('Translation proxy failed:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Failed to translate' }, 502);
  }
});

export default translate;
