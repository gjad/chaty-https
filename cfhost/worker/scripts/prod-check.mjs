// Read-only production check: health, visitor auth, WebSocket upgrade + join (no messages are written).
const BASE = process.argv[2] || 'https://chatboxy-api.axcf.workers.dev';
const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
console.log('health', health);

const auth = await fetch(`${BASE}/api/visitor-auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
console.log('visitor-auth', { ok: auth.success, hasToken: !!auth.visitorToken });

const bad = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nobody', password: 'x' }) });
console.log('bad login ->', bad.status);

await new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
  const timer = setTimeout(() => { console.log('ws: timeout'); resolve(); }, 8000);
  ws.onmessage = (evt) => {
    const f = JSON.parse(evt.data);
    console.log('ws frame', f.e);
    if (f.e === 'version-check') {
      ws.send(JSON.stringify({ e: 'visitor-join', d: { visitorId: auth.visitorId, visitorName: auth.visitorName, roomId: '', currentPage: 'https://deploy-check', visitorToken: auth.visitorToken } }));
    }
    if (f.e === 'joined') { clearTimeout(timer); ws.close(); resolve(); }
  };
  ws.onerror = () => { console.log('ws error'); resolve(); };
});
