// Builds the Cloudflare Pages output (dist/) for the embed widget:
//   embed.js -> embed.min.js (terser), plus loader, settings, compressor, realtime client and headers.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

execFileSync(process.execPath, [join(here, '..', 'scripts', 'sync-rt-client.mjs')], { stdio: 'inherit' });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const source = readFileSync(join(here, 'embed.js'), 'utf8');
const result = await minify(source, { compress: true, mangle: true, format: { comments: false } });
if (!result.code) throw new Error('terser produced no output');
writeFileSync(join(dist, 'embed.min.js'), result.code);

for (const file of ['embed.js', 'emloader.js', 'embed-settings.js', 'compressor.min.js', 'rt-client.js']) {
  copyFileSync(join(here, file), join(dist, file));
}

writeFileSync(
  join(dist, '_headers'),
  `/*
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff

/emloader.js
  Cache-Control: no-cache

/embed.js
  Cache-Control: no-cache

/embed-settings.js
  Cache-Control: public, max-age=15552000, immutable

/embed.min.js
  Cache-Control: public, max-age=15552000, immutable

/rt-client.js
  Cache-Control: public, max-age=15552000, immutable

/compressor.min.js
  Cache-Control: public, max-age=15552000, immutable
`
);

console.log('embed widget built to', dist);
