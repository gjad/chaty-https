// Bumps the app version everywhere it is hard-coded, so they always stay in sync:
//   worker/wrangler.jsonc          -> vars.APP_VERSION   (sent to clients via the version-check event)
//   embed_widget/emloader.js       -> DEFAULT_VERSION    (cache-buster for embed.min.js?v=<version>)
// Usage: node scripts/bump-version.mjs [version]   (default: current APP_VERSION + 1)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerPath = join(root, 'worker', 'wrangler.jsonc');
const loaderPath = join(root, 'embed_widget', 'emloader.js');

const wrangler = readFileSync(wranglerPath, 'utf8');
const wranglerRe = /("APP_VERSION"\s*:\s*")([^"]*)(")/;
const match = wrangler.match(wranglerRe);
if (!match) throw new Error('APP_VERSION not found in worker/wrangler.jsonc');

const current = match[2];
const next = process.argv[2] || String((parseInt(current, 10) || 0) + 1);
if (!/^\d+(\.\d+)*$/.test(next)) throw new Error(`Invalid version: ${next}`);

writeFileSync(wranglerPath, wrangler.replace(wranglerRe, `$1${next}$3`));

const loader = readFileSync(loaderPath, 'utf8');
const loaderRe = /(var DEFAULT_VERSION\s*=\s*')([^']*)(')/;
if (!loaderRe.test(loader)) throw new Error('DEFAULT_VERSION not found in embed_widget/emloader.js');
writeFileSync(loaderPath, loader.replace(loaderRe, `$1${next}$3`));

console.log(`Version bumped: ${current} -> ${next}`);
