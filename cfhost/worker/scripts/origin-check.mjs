// Checks the ALLOWED_ORIGINS enforcement. Start the Worker with an explicit list first:
//   npx wrangler dev --var "ALLOWED_ORIGINS:https://ok.example.com,https://*.partner.com" --var "ALLOW_ANY_ORIGIN:false"
// then: node scripts/origin-check.mjs
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra));
  }
};

const visitorAuth = (origin) =>
  fetch(`${BASE}/api/visitor-auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: '{}'
  });

const wsOpens = (origin) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`, origin ? { headers: { origin } } : undefined);
    const timer = setTimeout(() => resolve(false), 4000);
    ws.onmessage = () => { clearTimeout(timer); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
    ws.onclose = () => { clearTimeout(timer); resolve(false); };
  });

console.log('visitor-auth');
for (const [origin, expected] of [
  ['https://ok.example.com', 200],
  ['https://shop.partner.com', 200],
  [BASE, 200],
  ['https://evil.com', 403],
  ['https://partner.com', 403],
  ['https://evilpartner.com', 403],
  ['http://ok.example.com', 403],
  [undefined, 403]
]) {
  const res = await visitorAuth(origin);
  check(`${origin ?? '(no Origin)'} -> ${expected}`, res.status === expected, res.status);
  if (expected === 200) check(`  CORS header reflects ${origin}`, res.headers.get('access-control-allow-origin') === origin);
}

console.log('preflight');
{
  const bad = await fetch(`${BASE}/api/visitor-auth`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
  });
  check('evil origin gets no CORS grant', !bad.headers.get('access-control-allow-origin'), bad.headers.get('access-control-allow-origin'));
  const good = await fetch(`${BASE}/api/visitor-auth`, {
    method: 'OPTIONS',
    headers: { origin: 'https://ok.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
  });
  check('allowed origin gets CORS grant', good.headers.get('access-control-allow-origin') === 'https://ok.example.com');
}

console.log('upload');
{
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { origin: 'https://evil.com' }, body: new FormData() });
  check('upload from evil origin -> 403', res.status === 403, res.status);
}

console.log('websocket');
check('allowed origin connects', await wsOpens('https://ok.example.com'));
check('wildcard subdomain connects', await wsOpens('https://a.b.partner.com'));
check('own origin connects', await wsOpens(BASE));
check('evil origin is rejected', !(await wsOpens('https://evil.com')));
check('missing Origin is rejected', !(await wsOpens(undefined)));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
