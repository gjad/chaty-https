import type { Env } from '../types';

// Bark push notifications. Endpoints come from the BARK_URLS secret (comma separated).
export async function sendBark(env: Env, title: string, body: string, group = 'chat'): Promise<void> {
  if (env.BARK_ENABLED === 'false') return;
  const urls = (env.BARK_URLS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (!urls.length) return;

  const params = new URLSearchParams();
  if (group) params.set('group', group);
  if (env.APP_URL) params.set('url', env.APP_URL);

  await Promise.all(
    urls.map(async (raw) => {
      const base = raw.endsWith('/') ? raw.slice(0, -1) : raw;
      const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${params.toString()}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) console.error(`Bark API error ${res.status} for ${base}`);
      } catch (err) {
        console.error(`Bark push failed for ${base}:`, err instanceof Error ? err.message : err);
      }
    })
  );
}
