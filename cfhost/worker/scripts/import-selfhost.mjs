// One-off migration: copies data and uploaded images from the self-hosted server into the Cloudflare deployment.
//
//   ADMIN_TOKEN=... node scripts/import-selfhost.mjs \
//     --db ../../selfhost/server/db/chat.db --uploads ../../selfhost/chatuploads --url https://svc.example.com
//
// Options: --skip-files (only database rows), --skip-db (only images).
// Safe to re-run: rows are upserted by primary key and R2 objects are overwritten.
// Uses node:sqlite (Node >= 22.5), so no native modules are needed.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const dbPath = opt('--db');
const uploadsDir = opt('--uploads');
const baseUrl = (opt('--url') || process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = process.env.ADMIN_TOKEN;
const skipDb = args.includes('--skip-db');
const skipFiles = args.includes('--skip-files');

if (!token || (!skipDb && !dbPath) || (!skipFiles && !uploadsDir)) {
  console.error('Usage: ADMIN_TOKEN=... node scripts/import-selfhost.mjs --db <chat.db> --uploads <chatuploads dir> [--url <base url>] [--skip-db] [--skip-files]');
  process.exit(1);
}
if (!dbPath) {
  console.error('--db is required (it is also used to list the uploaded files)');
  process.exit(1);
}

const headers = { authorization: `Bearer ${token}` };
const db = new DatabaseSync(dbPath, { readOnly: true });

const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

// Parents first, although the target schema has no foreign keys.
const TABLES = ['agents', 'rooms', 'messages', 'room_reads', 'agent_sessions', 'upload_files', 'knowledge_entries'];
const CHUNK = 500;

async function postRows(table, rows) {
  const res = await fetch(`${baseUrl}/api/admin/import`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ table, rows })
  });
  if (!res.ok) throw new Error(`import ${table} failed: ${res.status} ${await res.text()}`);
}

if (!skipDb) {
  for (const table of TABLES) {
    if (!tableExists(table)) {
      console.log(`- ${table}: not present in source, skipped`);
      continue;
    }
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    for (let i = 0; i < rows.length; i += CHUNK) {
      await postRows(table, rows.slice(i, i + CHUNK));
    }
    console.log(`- ${table}: ${rows.length} rows`);
  }
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

if (!skipFiles && tableExists('upload_files')) {
  const keys = db.prepare('SELECT filename FROM upload_files').all().map((r) => r.filename);
  let copied = 0;
  let missing = 0;
  for (const key of keys) {
    const file = join(uploadsDir, ...key.split('/'));
    if (!existsSync(file)) {
      missing += 1;
      console.warn(`  missing on disk: ${key}`);
      continue;
    }
    const ext = key.split('.').pop().toLowerCase();
    const res = await fetch(`${baseUrl}/api/admin/files/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': MIME[ext] || 'application/octet-stream' },
      body: readFileSync(file)
    });
    if (!res.ok) throw new Error(`upload ${key} failed: ${res.status} ${await res.text()}`);
    copied += 1;
  }
  console.log(`- files: ${copied} copied, ${missing} missing`);
}

const stats = await fetch(`${baseUrl}/api/admin/stats`, { headers }).then((r) => r.json());
console.log('Row counts on the target:', stats);
