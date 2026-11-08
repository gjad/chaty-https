// Signed cookies (HMAC-SHA256). Format: <encodeURIComponent(value)>.<expiresAtSeconds>.<base64url(signature)>
// Used for the `visitorAuth` cookie, both in the Worker (HTTP) and in the ChatHub (WebSocket upgrade).
//
// The signing key is *derived* from the configured secret with a purpose label, and the signed text carries a
// domain prefix plus an expiry. A value signed here can therefore never double as a JWT (which is signed with the
// raw JWT secret), even when COOKIE_SECRET is not configured and the cookie secret falls back to JWT_SECRET.

const encoder = new TextEncoder();

const KEY_LABEL = 'efx/visitor-cookie/v2';
const SIGN_PREFIX = 'visitorAuth.v2.';

const toBase64Url = (buf: ArrayBuffer): string => {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const hmacParams = { name: 'HMAC', hash: 'SHA-256' } as const;

const keyCache = new Map<string, Promise<CryptoKey>>();

const derivedKey = (secret: string): Promise<CryptoKey> => {
  let key = keyCache.get(secret);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey('raw', encoder.encode(secret), hmacParams, false, ['sign']);
      const derived = await crypto.subtle.sign('HMAC', base, encoder.encode(KEY_LABEL));
      return crypto.subtle.importKey('raw', derived, hmacParams, false, ['sign']);
    })();
    keyCache.set(secret, key);
  }
  return key;
};

const sign = async (data: string, secret: string): Promise<string> =>
  toBase64Url(await crypto.subtle.sign('HMAC', await derivedKey(secret), encoder.encode(data)));

const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export async function signCookieValue(value: string, secret: string, ttlSeconds: number): Promise<string> {
  const encoded = encodeURIComponent(value);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${encoded}.${exp}.${await sign(`${SIGN_PREFIX}${exp}.${encoded}`, secret)}`;
}

export async function verifySignedCookieValue(raw: string | undefined | null, secret: string): Promise<string | null> {
  if (!raw) return null;
  const sigDot = raw.lastIndexOf('.');
  if (sigDot <= 0) return null;
  const expDot = raw.lastIndexOf('.', sigDot - 1);
  if (expDot <= 0) return null;

  const encoded = raw.slice(0, expDot);
  const expText = raw.slice(expDot + 1, sigDot);
  const signature = raw.slice(sigDot + 1);
  if (!/^\d{1,12}$/.test(expText)) return null;
  const exp = Number(expText);
  if (exp * 1000 < Date.now()) return null;

  if (!safeEqual(signature, await sign(`${SIGN_PREFIX}${exp}.${encoded}`, secret))) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
