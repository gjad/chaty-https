// Structured security log lines. They go to Workers Logs (observability) as one JSON object per line, so they can
// be filtered there with `type = security` and grouped by `event`. Never put passwords, tokens or message text in here.
import { clientIp } from './util';

type Fields = Record<string, string | number | boolean | null | undefined>;

const clip = (value: string | null | undefined, max: number): string | undefined => (value ? value.slice(0, max) : undefined);

export function requestInfo(req: Request) {
  const cf = (req as Request & { cf?: { country?: string; asn?: number } }).cf;
  return {
    ip: clientIp(req),
    country: cf?.country,
    asn: cf?.asn,
    ua: clip(req.headers.get('user-agent'), 200)
  };
}

export function securityLog(event: string, req: Request | null, fields: Fields = {}): void {
  const base = req ? { ...requestInfo(req), method: req.method, path: new URL(req.url).pathname } : {};
  console.warn(JSON.stringify({ type: 'security', event, ...base, ...fields }));
}
