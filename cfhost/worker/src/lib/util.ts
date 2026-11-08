import { VISITOR_NAMES } from './names';

export const pickRandomVisitorName = (): string => {
  if (!VISITOR_NAMES.length) return 'Visitor';
  return VISITOR_NAMES[Math.floor(Math.random() * VISITOR_NAMES.length)] || 'Visitor';
};

export const generateRoomId = (): string => `room-${crypto.randomUUID()}`;

export const ROOM_ID_PATTERN = /^room-[A-Za-z0-9-]{1,128}$/;

// Same rule as the self-hosted server: optional YYYY/MM/ prefix + safe file name.
export const UPLOAD_KEY_PATTERN = /^(?:\d{4}\/\d{2}\/)?[A-Za-z0-9._-]{1,255}$/;

export const clientIp = (req: Request): string => req.headers.get('cf-connecting-ip') || 'unknown';

// Rate-limit key for a request. Only the Cloudflare-provided address is trusted (x-forwarded-for is client
// controlled). IPv6 clients are bucketed per /64 because a single subscriber usually owns the whole prefix.
export const clientKey = (req: Request): string => ipRateKey(clientIp(req));

export function ipRateKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];

  let groups: string[];
  if (lower.includes('::')) {
    const [head, tail = ''] = lower.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return ip;
    groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  } else {
    groups = lower.split(':');
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

// Page URLs come from the visitor's browser and end up in an <a href> inside the agent app: http(s) only.
export function sanitizePageUrl(raw: unknown, max = 500): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim().slice(0, max);
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

export type JsonBody = { ok: true; body: Record<string, unknown> } | { ok: false; status: 400 | 413 };

// Reads a JSON object body with a hard size cap (Content-Length is checked first, the real length afterwards).
export async function readJsonBody(req: Request, maxBytes: number): Promise<JsonBody> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400 };
  }
  if (text.length > maxBytes) return { ok: false, status: 413 };
  if (!text.trim()) return { ok: true, body: {} };

  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, body: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {} };
  } catch {
    return { ok: false, status: 400 };
  }
}

// Time values are stored as ISO-8601 strings everywhere so plain string comparison orders them correctly.
export const nowIso = (): string => new Date().toISOString();

// Parses both ISO strings and legacy SQLite "YYYY-MM-DD HH:MM:SS" (UTC) values.
export function parseDbTime(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}
