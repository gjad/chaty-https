// Creates an agent account (the self-hosted server expected this to be done manually, too).
//   ADMIN_TOKEN=... npm run agent:create -- <username> <password> [display name] [--url https://svc.example.com]
// Defaults to the local `wrangler dev` server and reads ADMIN_TOKEN from the environment or .dev.vars.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const baseUrl = (urlIdx >= 0 ? args[urlIdx + 1] : process.env.BASE_URL) || 'http://127.0.0.1:8787';
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--url');
const [username, password, name] = positional;

const tokenFromDevVars = () => {
  try {
    const match = readFileSync('.dev.vars', 'utf8').match(/^ADMIN_TOKEN=(.+)$/m);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
};
const token = process.env.ADMIN_TOKEN || tokenFromDevVars();

if (!username || !password) {
  console.error('Usage: npm run agent:create -- <username> <password> [display name] [--url <base url>]');
  process.exit(1);
}
if (!token) {
  console.error('ADMIN_TOKEN is required (environment variable or .dev.vars)');
  process.exit(1);
}

const res = await fetch(`${baseUrl}/api/admin/agents`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ username, password, name: name || username })
});
const body = await res.json().catch(() => ({}));
console.log(res.status, JSON.stringify(body));
process.exit(res.ok ? 0 : 1);
