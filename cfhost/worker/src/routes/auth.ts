import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import bcrypt from 'bcryptjs';
import { authenticateAgent, agentTokenOf, sessionIdOf, visitorTokenOf, signedVisitorCookie } from '../lib/auth';
import type { AppEnv } from '../lib/auth';
import { cookieSecret } from '../types';
import { signCookieValue } from '../lib/cookies';
import { signAgentToken, signVisitorToken, verifyAgentToken, verifyVisitorToken } from '../lib/jwt';
import { getHub, rateBlocked, rateFail, rateLimit } from '../lib/access';
import { clientKey, pickRandomVisitorName, readJsonBody } from '../lib/util';
import { recordAudit } from '../lib/audit';
import { securityLog } from '../lib/log';

const auth = new Hono<AppEnv>();

// Hono rejects Max-Age above 400 days (the browser cap), so "permanent" login is 400 days.
const AGENT_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const VISITOR_COOKIE_MAX_AGE = 24 * 60 * 60;
const MIN_PASSWORD_LENGTH = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Compared against when the username does not exist so both outcomes cost one bcrypt run (no user enumeration by timing).
const DUMMY_HASH = '$2b$10$acZmuK.Wdfh8qcG2gYniLOssZTdbkQTq3YGxw0RBtOLFanKoVrN7O';

const baseCookie = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

// bcrypt runs here in the Worker (stateless, CPU heavy) so the ChatHub stays free for realtime traffic.
// Only *failed* attempts are counted (20 per IP, 30 per account per 15 minutes): agents sharing an office IP
// do not lock each other out by signing in successfully.
auth.post('/login', async (c) => {
  const ip = clientKey(c.req.raw);

  const parsed = await readJsonBody(c.req.raw, 8 * 1024);
  if (!parsed.ok) return c.json({ error: 'Invalid request' }, parsed.status);
  const body = parsed.body;
  const username = typeof body.username === 'string' ? body.username.slice(0, 100) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const accountKey = username.toLowerCase();

  if (c.env.TURNSTILE_SECRET) {
    const token = typeof body.turnstileToken === 'string' ? body.turnstileToken.slice(0, 2048) : '';
    const form = new FormData();
    form.set('secret', c.env.TURNSTILE_SECRET);
    form.set('response', token);
    if (ip) form.set('remoteip', ip);
    const ok = token
      ? await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
          .then((r) => r.json() as Promise<{ success?: boolean }>)
          .then((r) => r.success === true)
          .catch(() => false)
      : false;
    if (!ok) {
      securityLog('login_turnstile_fail', c.req.raw, { username: username.slice(0, 64) });
      return c.json({ error: '人机验证失败，请重试' }, 403);
    }
  }

  const retry =
    (await rateBlocked(c.env, 'login-ip', ip, 20, LOGIN_WINDOW_MS)) ??
    (accountKey ? await rateBlocked(c.env, 'login-user', accountKey, 30, LOGIN_WINDOW_MS) : null);
  if (retry !== null) {
    securityLog('login_rate_limited', c.req.raw, { username: username.slice(0, 64) });
    c.header('Retry-After', String(retry));
    return c.json({ error: '登录尝试过于频繁，请15分钟后重试' }, 429);
  }

  const hub = getHub(c.env);
  const agent = username ? await hub.getAgentByUsername(username) : null;
  const passwordOk = await bcrypt.compare(password, agent ? agent.passwordHash : DUMMY_HASH).catch(() => false);
  if (!agent || !password || !passwordOk) {
    // Unknown usernames only go to Workers Logs (anyone can generate those); failures against a real account are audited.
    securityLog('login_fail', c.req.raw, { username: username.slice(0, 64), knownUser: !!agent });
    if (agent) recordAudit(c, { actorType: 'agent', actorId: agent.agentId, action: 'login', result: 'fail', target: agent.username });
    await Promise.all([
      rateFail(c.env, 'login-ip', ip, 20, LOGIN_WINDOW_MS),
      accountKey ? rateFail(c.env, 'login-user', accountKey, 30, LOGIN_WINDOW_MS) : Promise.resolve()
    ]);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = await signAgentToken({ agentId: agent.agentId, username: agent.username }, c.env.JWT_SECRET);

  const userAgent = (c.req.header('user-agent') || '').slice(0, 300);
  const deviceType = /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent) ? 'mobile' : 'pc';
  const sessionId = await hub.createAgentSession({ agentId: agent.agentId, deviceType, userAgent });

  setCookie(c, 'agent_token', token, { ...baseCookie, maxAge: AGENT_COOKIE_MAX_AGE });
  setCookie(c, 'agent_session', sessionId, { ...baseCookie, maxAge: AGENT_COOKIE_MAX_AGE });

  recordAudit(c, {
    actorType: 'agent',
    actorId: agent.agentId,
    action: 'login',
    result: 'ok',
    target: agent.username,
    detail: `device=${deviceType} session=${sessionId.slice(0, 8)}`
  });
  return c.json({ sessionId, agent: { agentId: agent.agentId, name: agent.name } });
});

// Ends the caller's own session only (the JWT identifies the agent, the session id must belong to that agent).
auth.post('/logout', async (c) => {
  const token = agentTokenOf(c);
  const agent = token ? await verifyAgentToken(token, c.env.JWT_SECRET) : null;
  const sessionId = sessionIdOf(c);
  if (agent && sessionId) {
    await getHub(c.env).endSession(sessionId, agent.agentId);
    recordAudit(c, { actorType: 'agent', actorId: agent.agentId, action: 'logout', result: 'ok', target: agent.username, detail: `session=${sessionId.slice(0, 8)}` });
  }

  deleteCookie(c, 'agent_token', baseCookie);
  deleteCookie(c, 'agent_session', baseCookie);
  deleteCookie(c, 'agent_info', { ...baseCookie, httpOnly: false });
  return c.json({ success: true });
});

auth.post('/change-password', authenticateAgent, async (c) => {
  const sessionId = c.get('sessionId');
  const agentId = c.get('agent').agentId;

  const retry = await rateBlocked(c.env, 'chgpw', agentId, 5, LOGIN_WINDOW_MS);
  if (retry !== null) {
    securityLog('change_password_rate_limited', c.req.raw, { agentId });
    c.header('Retry-After', String(retry));
    return c.json({ error: '尝试次数过多，请稍后再试' }, 429);
  }

  const parsed = await readJsonBody(c.req.raw, 8 * 1024);
  if (!parsed.ok) return c.json({ error: 'Invalid request' }, parsed.status);
  const currentPassword = typeof parsed.body.currentPassword === 'string' ? parsed.body.currentPassword : '';
  const newPassword = typeof parsed.body.newPassword === 'string' ? parsed.body.newPassword : '';

  if (!currentPassword || !newPassword) return c.json({ error: '请填写当前密码和新密码' }, 400);
  if (newPassword.length < MIN_PASSWORD_LENGTH) return c.json({ error: `新密码长度至少 ${MIN_PASSWORD_LENGTH} 位` }, 400);

  const hub = getHub(c.env);
  const agent = await hub.getAgentById(agentId);
  if (!agent) return c.json({ error: '账号不存在' }, 404);
  if (!(await bcrypt.compare(currentPassword, agent.passwordHash).catch(() => false))) {
    await rateFail(c.env, 'chgpw', agentId, 5, LOGIN_WINDOW_MS);
    recordAudit(c, { actorType: 'agent', actorId: agentId, action: 'change_password', result: 'fail', detail: 'wrong current password' });
    return c.json({ error: '当前密码不正确' }, 401);
  }

  await hub.changeAgentPassword(agent.agentId, await bcrypt.hash(newPassword, 10), sessionId);
  recordAudit(c, { actorType: 'agent', actorId: agentId, action: 'change_password', result: 'ok', detail: 'other sessions revoked' });
  return c.json({ success: true });
});

auth.get('/verify-token', async (c) => {
  const token = agentTokenOf(c);
  if (!token) return c.json({ error: 'No token found' }, 401);

  const decoded = await verifyAgentToken(token, c.env.JWT_SECRET);
  if (!decoded) return c.json({ error: 'Invalid token' }, 401);

  const sessionId = sessionIdOf(c);
  if (!sessionId) return c.json({ error: 'Session ID required' }, 401);

  const agent = await getHub(c.env).verifyAgentSession(decoded.agentId, sessionId);
  if (!agent) return c.json({ error: 'Session expired' }, 401);

  return c.json({ sessionId, agent });
});

// Visitor identity: issues the signed cookie (same-site use) and a 30-day JWT (cross-site embeds).
// An identity can only be *continued* with a valid signed cookie / token. A client-supplied visitorId is never
// adopted: without proof the caller gets a fresh random id, so knowing (or guessing) someone's id is worthless.
auth.post('/visitor-auth', async (c) => {
  const ip = clientKey(c.req.raw);
  const tooMany = (retry: number) => {
    c.header('Retry-After', String(retry));
    return c.json({ error: 'Too many requests' }, 429);
  };

  const general = await rateLimit(c.env, 'vauth', ip, 120, 60_000);
  if (general !== null) {
    securityLog('visitor_auth_rate_limited', c.req.raw);
    return tooMany(general);
  }

  const parsed = await readJsonBody(c.req.raw, 4 * 1024);
  if (!parsed.ok && parsed.status === 413) return c.json({ error: 'Payload too large' }, 413);
  const body = parsed.ok ? parsed.body : {};
  const bodyToken = typeof body.visitorToken === 'string' ? body.visitorToken.trim() : '';

  const cookieVisitorId = ((await signedVisitorCookie(c)) || '').trim();
  const tokenVisitorId = await verifyVisitorToken(visitorTokenOf(c) || bodyToken, c.env.JWT_SECRET);

  let visitorId = tokenVisitorId || cookieVisitorId;
  if (!visitorId || visitorId.length > 100) {
    const fresh = await rateLimit(c.env, 'vnew', ip, 60, 10 * 60_000);
    if (fresh !== null) return tooMany(fresh);
    visitorId = crypto.randomUUID();
  }

  const existingRoom = await getHub(c.env).getVisitorRoomSummary(visitorId);
  const visitorName = existingRoom && existingRoom.visitorName ? String(existingRoom.visitorName) : pickRandomVisitorName();

  setCookie(c, 'visitorAuth', await signCookieValue(visitorId, cookieSecret(c.env), VISITOR_COOKIE_MAX_AGE), {
    ...baseCookie,
    maxAge: VISITOR_COOKIE_MAX_AGE
  });

  return c.json({
    success: true,
    visitorId,
    visitorName,
    roomId: existingRoom ? existingRoom.roomId : '',
    visitorToken: await signVisitorToken(visitorId, c.env.JWT_SECRET)
  });
});

export default auth;
