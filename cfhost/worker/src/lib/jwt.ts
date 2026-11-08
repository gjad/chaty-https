import { SignJWT, jwtVerify } from 'jose';
import type { AgentIdentity } from '../types';

const encoder = new TextEncoder();

const key = (secret: string) => encoder.encode(secret);

export async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  expiresIn: string
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key(secret));
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  if (!token || typeof token !== 'string') return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'], requiredClaims: ['exp'] });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function verifyAgentToken(token: string | null | undefined, secret: string): Promise<AgentIdentity | null> {
  if (!token) return null;
  const payload = await verifyJwt(token, secret);
  if (!payload || payload.type === 'visitor' || typeof payload.agentId !== 'string' || !payload.agentId) return null;
  return {
    agentId: payload.agentId,
    username: typeof payload.username === 'string' ? payload.username : ''
  };
}

export async function verifyVisitorToken(token: string | null | undefined, secret: string): Promise<string | null> {
  if (!token) return null;
  const payload = await verifyJwt(token.trim(), secret);
  if (payload && payload.type === 'visitor' && typeof payload.visitorId === 'string' && payload.visitorId.trim()) {
    return payload.visitorId.trim();
  }
  return null;
}

// The agent JWT only proves who the agent is; the live `agent_sessions` row is the real authority (revocable,
// idle-expiring), so the lifetime just needs to cover the 400 day cookie.
export const signAgentToken = (agent: AgentIdentity, secret: string) =>
  signJwt({ agentId: agent.agentId, username: agent.username }, secret, '400d');

// 30 days = the widget's persisted-session window. The token is renewed on every /visitor-auth call.
export const signVisitorToken = (visitorId: string, secret: string) =>
  signJwt({ type: 'visitor', visitorId }, secret, '30d');
