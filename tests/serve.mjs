// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Chirichella Inc.
// Two static servers that send the real headers: the page origin harness on
// circuitcenter.localhost:4173 (COOP same-origin, COEP credentialless,
// frame-src) and the island on editor.circuitcenter.localhost:4174 (the
// snippet the site's nginx includes). *.localhost resolves to 127.0.0.1.
// The page origin also serves tests/fixtures under /fixtures/, so the harness
// loads its fixture projects same-origin, and tests/e2e/fixtures under
// /e2e-fixtures/ (the boards the import tests hand over).
// With LIBS_DIR set, the island also serves that directory as /libs/ (the
// library mirror, LIBRARY.md: LIBS_DIR holds <tag>/manifest.json.gz and the
// rest, gzip only, sent with Content-Encoding gzip like every .gz here).
// Without it /libs/ is a 404 and the island boots on its example library.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { islandHeaders } from './headers.mjs';

const TYPES = { '.txt': 'text/plain; charset=utf-8', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PAGE = 'http://circuitcenter.localhost:4173';
const ISLAND = 'http://editor.circuitcenter.localhost:4174';
const LIBS_DIR = process.env.LIBS_DIR ? resolve(process.env.LIBS_DIR) : null;

function serveFile(root, urlPath, res, headers) {
  let p = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '\\') p = '/current/index.html';
  if (p === '/island.json') p = '/current/island.json';
  let file = join(root, p);
  let encoding = null;
  if (!existsSync(file) && existsSync(`${file}.gz`)) { file = `${file}.gz`; encoding = 'gzip'; }
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, headers); return res.end(); }
  const ext = extname(encoding ? file.slice(0, -3) : file);
  const type = TYPES[ext] ?? 'application/octet-stream';
  // Content-Length as nginx sends it for a static file (the stored, compressed size for a .gz):
  // the loader's progress, and so the booting heartbeat, needs a known total.
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': statSync(file).size, ...(encoding ? { 'Content-Encoding': encoding } : {}), 'Cache-Control': p.startsWith('/current/') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/libs' || path.startsWith('/libs/')) {
    if (LIBS_DIR == null) { res.writeHead(404, islandHeaders(PAGE)); return res.end(); }
    return serveFile(LIBS_DIR, path.slice('/libs'.length), res, islandHeaders(PAGE));
  }
  return serveFile('dist', path, res, islandHeaders(PAGE));
}).listen(4174, '127.0.0.1');
createServer((req, res) => {
  const path = req.url.split('?')[0];
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Content-Security-Policy': `frame-src ${ISLAND}` };
  if (path.startsWith('/fixtures/')) return serveFile('tests/fixtures', path.slice('/fixtures'.length), res, headers);
  if (path.startsWith('/e2e-fixtures/')) return serveFile('tests/e2e/fixtures', path.slice('/e2e-fixtures'.length), res, headers);
  return serveFile('tests/harness', path, res, headers);
}).listen(4173, '127.0.0.1');
console.log(`page ${PAGE}  island ${ISLAND}${LIBS_DIR ? `  libs ${LIBS_DIR}` : ''}`);
