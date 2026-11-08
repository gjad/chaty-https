import type { Context, MiddlewareHandler } from 'hono';
import type { AgentIdentity, Env } from '../types';
import { cookieSecret } from '../types';
import { parseCookieHeader, verifySignedCookieValue } from './cookies';
import { verifyAgentToken, verifyVisitorToken } from './jwt';
import { getHub } from './access';
import { securityLog } from './log';

export type AppEnv = {
  Bindings: Env;
  Variables: { agent: AgentIdentity; sessionId: string };
};

export type AppContext = Context<AppEnv>;

export const cookiesOf = (c: AppContext) => parseCookieHeader(c.req.header('cookie'));

export const agentTokenOf = (c: AppContext): string | undefined => {
  const cookies = cookiesOf(c);
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return bearer || cookies.agent_token || cookies.token || undefined;
};

export const sessionIdOf = (c: AppContext): string | undefined =>
  cookiesOf(c).agent_session || c.req.header('x-session-id') || undefined;

export const visitorTokenOf = (c: AppContext): string | null => {
  const header = c.req.header('x-visitor-token');
  if (header && header.trim()) return header.trim();
  const query = c.req.query('vt');
  if (query && query.trim()) return query.trim();
  return null;
};

export const signedVisitorCookie = (c: AppContext): Promise<string | null> =>
  verifySignedCookieValue(cookiesOf(c).visitorAuth, cookieSecret(c.env));

// Visitor ids proven by the signed cookie and/or the visitor JWT (either one is enough).
export async function verifiedVisitorIds(c: AppContext, extraToken?: string): Promise<string[]> {
  const ids: string[] = [];
  const fromCookie = await signedVisitorCookie(c);
  if (fromCookie) ids.push(fromCookie);
  const fromToken = await verifyVisitorToken(visitorTokenOf(c) || extraToken, c.env.JWT_SECRET);
  if (fromToken) ids.push(fromToken);
  return ids;
}

// Resolves the calling agent: valid JWT *and* a live, non-expired session row. Every agent-only data path
// (history, uploads, file delivery, ...) must use this instead of trusting the JWT alone, so that logout,
// password change and "signed in elsewhere" take effect immediately.
export async function resolveAgent(c: AppContext): Promise<{ agent: AgentIdentity; sessionId: string } | null> {
  const token = agentTokenOf(c);
  if (!token) return null;
  const agent = await verifyAgentToken(token, c.env.JWT_SECRET);
  if (!agent) return null;
  const sessionId = sessionIdOf(c);
  if (!sessionId) return null;
  const live = await getHub(c.env).verifyAgentSession(agent.agentId, sessionId);
  return live ? { agent, sessionId } : null;
}

// Agent API guard: valid JWT *and* a live session row (revoked / kicked sessions are rejected).
export const authenticateAgent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = agentTokenOf(c);
  if (!token) return c.json({ error: 'Unauthorized: No token provided' }, 401);

  const agent = await verifyAgentToken(token, c.env.JWT_SECRET);
  if (!agent) {
    securityLog('agent_token_invalid', c.req.raw);
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }

  const sessionId = sessionIdOf(c);
  if (!sessionId) return c.json({ error: 'Unauthorized: Session required' }, 401);

  const live = await getHub(c.env).verifyAgentSession(agent.agentId, sessionId);
  if (!live) return c.json({ error: 'Unauthorized: Session expired' }, 401);

  c.set('agent', agent);
  c.set('sessionId', sessionId);
  await next();
};
