// End-to-end smoke test against a running `wrangler dev` (default http://127.0.0.1:8787).
//   1. npm run dev                                   (separate terminal; the database is created on first use)
//   2. npm run agent:create -- alice secret123 Alice (needs ADMIN_TOKEN in .dev.vars)
//   3. npm run smoke
// Note: only *failed* logins are rate limited (20 per IP / 30 per account per 15 minutes), so repeated runs are fine.
// Needs ALLOW_ANY_ORIGIN=true in .dev.vars (the script sends no Origin header).
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const USER = process.env.AGENT_USER || 'alice';
const PASS = process.env.AGENT_PASS || 'secret123';

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra));
  }
};

class Client {
  constructor(label) {
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.closed = null;
  }

  async open(headers) {
    this.ws = headers ? new WebSocket(`${WS_BASE}/ws`, { headers }) : new WebSocket(`${WS_BASE}/ws`);
    this.ws.onmessage = (evt) => {
      if (evt.data === 'pong') return this.push({ e: '__pong__' });
      let frame;
      try {
        frame = JSON.parse(evt.data);
      } catch {
        return;
      }
      this.push(frame);
    };
    this.ws.onclose = (evt) => {
      this.closed = { code: evt.code };
      this.push({ e: '__close__', d: evt.code });
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`${this.label}: websocket error`));
    });
  }

  push(frame) {
    this.frames.push(frame);
    this.waiters = this.waiters.filter((w) => {
      if (w.match(frame)) {
        w.resolve(frame);
        return false;
      }
      return true;
    });
  }

  waitFor(match, timeoutMs = 4000) {
    const found = this.frames.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
    });
  }

  event(name, timeoutMs) {
    return this.waitFor((f) => f.e === name, timeoutMs);
  }

  // Waits for a *new* occurrence (ignores frames already seen).
  nextEvent(name, timeoutMs) {
    const seen = new Set(this.frames);
    return this.waitFor((f) => f.e === name && !seen.has(f), timeoutMs);
  }

  send(e, d) {
    this.ws.send(JSON.stringify({ e, d }));
  }

  request(e, d, timeoutMs = 5000) {
    const id = (this.nextId = (this.nextId || 0) + 1);
    this.ws.send(JSON.stringify({ e, d, id }));
    return this.waitFor((f) => f.a === id, timeoutMs).then((f) => (f ? f.d : null));
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const json = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, init);
  let body = null;
  try {
    body = await res.clone().json();
  } catch {}
  return { res, body };
};

const cookieJar = (res) => {
  const jar = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
  }
  return jar;
};

const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
);

console.log('health');
{
  const { body } = await json('/api/health');
  check('health ok', body?.ok === true, body);
}

console.log('agent login');
let agentToken;
let agentSession;
let agentCookie;
{
  const bad = await json('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: 'wrong-password' })
  });
  check('wrong password -> 401', bad.res.status === 401, bad.body);

  const good = await json('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'smoke-pc' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  check('login ok', good.res.status === 200 && !!good.body?.sessionId, good.body);
  const jar = cookieJar(good.res);
  agentToken = jar.agent_token;
  agentSession = good.body.sessionId;
  agentCookie = `agent_token=${agentToken}; agent_session=${agentSession}`;
  check('cookies set', !!agentToken && jar.agent_session === agentSession, jar);

  const verify = await json('/api/verify-token', { headers: { cookie: agentCookie } });
  check('verify-token', verify.res.status === 200 && verify.body?.agent?.name, verify.body);
  const noAuth = await json('/api/knowledge-base');
  check('knowledge-base requires auth', noAuth.res.status === 401, noAuth.body);
}

console.log('visitor auth');
const visitor = {};
{
  const { res, body } = await json('/api/visitor-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  check('visitor-auth ok', res.status === 200 && body?.visitorId && body?.visitorToken, body);
  visitor.id = body.visitorId;
  visitor.name = body.visitorName;
  visitor.token = body.visitorToken;
  visitor.cookie = `visitorAuth=${encodeURIComponent(cookieJar(res).visitorAuth)}`;
  visitor.cookieValue = cookieJar(res).visitorAuth;

  // A client-supplied visitorId must never be adopted (identity can only be continued with proof).
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const forgedId = `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify({ agentId: 'x' }))}`;
  const adopt = await json('/api/visitor-auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId: forgedId })
  });
  check('client-supplied visitorId is not adopted', adopt.body?.visitorId && adopt.body.visitorId !== forgedId, adopt.body);

  // A signed visitor cookie must not work as an agent bearer token (no cookie <-> JWT confusion).
  const confuse = await json('/api/history/room-00000000-0000-0000-0000-000000000000', {
    headers: { authorization: `Bearer ${visitor.cookieValue}` }
  });
  check('visitor cookie is not an agent token', confuse.res.status === 401, confuse.body);
}

console.log('websocket: agent + visitor');
const agent = new Client('agent');
await agent.open();
check('version-check on connect', (await agent.event('version-check'))?.d === '79');
agent.ws.send('ping');
check('ping -> pong (auto response)', !!(await agent.event('__pong__')));
agent.send('agent-login', { token: agentToken, sessionId: agentSession });
const initialList = await agent.event('room-list');
check('agent-login -> room-list', Array.isArray(initialList?.d), initialList);

const visitorWs = new Client('visitor');
await visitorWs.open();
const evilVisitor = new Client('impostor');
await evilVisitor.open();
evilVisitor.send('visitor-join', { visitorId: 'someone-else', visitorToken: visitor.token });
check('visitor-join with mismatched id rejected', !!(await evilVisitor.event('error')));
evilVisitor.close();

visitorWs.send('visitor-join', {
  visitorId: visitor.id,
  visitorName: visitor.name,
  roomId: '',
  currentPage: 'https://example.com/pricing',
  visitorToken: visitor.token
});
const joined = await visitorWs.event('joined');
check('visitor joined', joined?.d?.roomId === '', joined);

const unauth = await visitorWs.request('send-message', { roomId: '', type: 'text', content: '' });
check('empty message rejected', unauth?.success === false, unauth);

const sent = await visitorWs.request('send-message', { roomId: '', senderType: 'visitor', type: 'text', content: 'hello from visitor' });
check('visitor first message acked + room created', sent?.success === true && sent.roomId?.startsWith('room-'), sent);
const roomId = sent.roomId;
check('agent got new-visitor', (await agent.event('new-visitor'))?.d?.roomId === roomId);
check('agent got new-message', (await agent.event('new-message'))?.d?.content === 'hello from visitor');
check('visitor got own new-message', !!(await visitorWs.event('new-message')));
const list1 = await agent.waitFor((f) => f.e === 'room-list' && f.d?.some((r) => r.roomId === roomId && r.unreadCount === 1));
check('room-list shows unread=1', !!list1);

const reply = await agent.request('send-message', { roomId, type: 'text', content: 'hi, agent here' });
check('agent reply acked', reply?.success === true, reply);
check('visitor received agent reply', (await visitorWs.waitFor((f) => f.e === 'new-message' && f.d?.senderType === 'agent'))?.d?.content === 'hi, agent here');
const list2 = await agent.waitFor((f) => f.e === 'room-list' && f.d?.some((r) => r.roomId === roomId && r.unreadCount === 0 && r.lastMessage === 'hi, agent here'));
check('room-list unread=0 after agent reply, preview updated', !!list2);

const forged = await visitorWs.request('send-message', { roomId: 'room-not-mine', type: 'text', content: 'x' });
check('visitor cannot post to foreign room', forged?.success === false, forged);

const tooLong = await visitorWs.request('send-message', { roomId, type: 'text', content: 'x'.repeat(4001) });
check('over-long message rejected', tooLong?.success === false && tooLong.code === 'TOO_LONG', tooLong);

visitorWs.send('visitor-page-change', { currentPage: 'javascript:alert(1)' });
await new Promise((resolve) => setTimeout(resolve, 400));

console.log('http: history');
{
  const asVisitor = await json(`/api/history/${roomId}`, { headers: { 'x-visitor-token': visitor.token } });
  check('visitor history', asVisitor.res.status === 200 && asVisitor.body?.messages?.length === 2, asVisitor.body);
  const asCookie = await json(`/api/history/${roomId}`, { headers: { cookie: visitor.cookie } });
  check('visitor history via signed cookie', asCookie.res.status === 200, asCookie.body);
  const asAgent = await json(`/api/history/${roomId}?limit=1`, { headers: { cookie: agentCookie } });
  check('agent history + limit', asAgent.res.status === 200 && asAgent.body?.messages?.length === 1, asAgent.body);
  check('non-http page url never stored', /^https?:\/\//.test(asAgent.body?.currentPage || ''), asAgent.body?.currentPage);
  const anon = await json(`/api/history/${roomId}`);
  check('anonymous history -> 401', anon.res.status === 401, anon.body);
}

console.log('uploads (R2)');
{
  const form = () => {
    const fd = new FormData();
    fd.append('image', new File([PNG], 'dot.png', { type: 'image/png' }));
    fd.append('roomId', roomId);
    return fd;
  };
  const anon = await json('/api/upload', { method: 'POST', body: form() });
  check('anonymous upload -> 401', anon.res.status === 401, anon.body);

  const fake = new FormData();
  fake.append('image', new File([new TextEncoder().encode('<script>alert(1)</script>')], 'x.png', { type: 'image/png' }));
  fake.append('roomId', roomId);
  const notImage = await json('/api/upload', { method: 'POST', headers: { 'x-visitor-token': visitor.token }, body: fake });
  check('non-image content rejected', notImage.res.status === 400, notImage.body);

  const up = await json('/api/upload', { method: 'POST', headers: { 'x-visitor-token': visitor.token }, body: form() });
  check('visitor upload ok', up.res.status === 200 && up.body?.url?.startsWith('/chatuploads/'), up.body);

  const direct = await fetch(`${BASE}${up.body.url}`);
  check('file without auth -> 403', direct.status === 403);
  const asVisitor = await fetch(`${BASE}${up.body.url}?vt=${encodeURIComponent(visitor.token)}`);
  check('file with visitor token -> 200 image/png', asVisitor.status === 200 && asVisitor.headers.get('content-type') === 'image/png');
  const asAgent = await fetch(`${BASE}${up.body.url}`, { headers: { cookie: agentCookie } });
  check('file as agent -> 200', asAgent.status === 200);

  const imgMsg = await visitorWs.request('send-message', { roomId, type: 'image', imageUrl: up.body.url });
  check('image message acked', imgMsg?.success === true, imgMsg);
  const forgedImg = await visitorWs.request('send-message', { roomId, type: 'image', imageUrl: '/chatuploads/2020/01/nope.png' });
  check('untrusted image url rejected', forgedImg?.success === false, forgedImg);
}

console.log('room status');
{
  agent.send('join-room', roomId);
  await agent.nextEvent('room-list');
  // Visitor just sent an image -> done must be blocked by the 30s guard.
  agent.send('update-room-status', { roomId, status: 'done' });
  const blocked = await agent.event('error');
  check('done blocked right after visitor message (30s guard)', typeof blocked?.d === 'string' && blocked.d.includes('秒'), blocked);
}

console.log('knowledge base');
{
  const put = await json('/api/knowledge-base', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: agentCookie },
    body: JSON.stringify({ categories: [{ name: 'Greetings', items: [{ title: 'Hello', content: 'Hi there' }, { title: '', content: 'skipped' }] }] })
  });
  check('PUT knowledge-base', put.res.status === 200 && put.body?.total === 1, put.body);
  const get = await json('/api/knowledge-base', { headers: { cookie: agentCookie } });
  check('GET knowledge-base', get.body?.categories?.[0]?.items?.[0]?.title === 'Hello', get.body);
}

console.log('second login kicks the first session');
{
  const second = await json('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'smoke-pc-2' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  check('second login ok', second.res.status === 200, second.body);
  const kicked = await agent.event('force-logout');
  check('first agent socket got force-logout', kicked?.d?.sessionId === agentSession, kicked);
  const closedByServer = await agent.event('__close__', 5000);
  check('first agent socket was closed by the server (4001)', closedByServer?.d === 4001, closedByServer);
  const stale = await json('/api/knowledge-base', { headers: { cookie: agentCookie } });
  check('old session rejected by API', stale.res.status === 401, stale.body);
  const staleHistory = await json(`/api/history/${roomId}`, { headers: { cookie: agentCookie } });
  check('old session cannot read history', staleHistory.res.status === 401, staleHistory.body);

  const jar = cookieJar(second.res);
  const newAgentCookie = `agent_token=${jar.agent_token}; agent_session=${second.body.sessionId}`;
  const okHistory = await json(`/api/history/${roomId}`, { headers: { cookie: newAgentCookie } });
  check('new session can read history', okHistory.res.status === 200, okHistory.body);
  const out = await json('/api/logout', { method: 'POST', headers: { cookie: newAgentCookie } });
  check('logout ok', out.body?.success === true);
  const afterLogout = await json(`/api/history/${roomId}`, { headers: { cookie: newAgentCookie } });
  check('logged-out session cannot read history', afterLogout.res.status === 401, afterLogout.body);
}

console.log('message flood is rate limited');
{
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => visitorWs.request('send-message', { roomId, type: 'text', content: `flood ${i}` })));
  check('flood: some messages rejected with RATE_LIMITED', results.some((r) => r?.code === 'RATE_LIMITED'), results.map((r) => r?.code || r?.success));
}

console.log('unauthenticated sockets are closed (server closes after ~10s; the close frame can take a further ~10s locally)');
{
  const idle = new Client('idle');
  await idle.open();
  const closed = await idle.event('__close__', 30000);
  check('idle socket closed with 4401', closed?.d === 4401, closed);
}

agent.close();
visitorWs.close();

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
